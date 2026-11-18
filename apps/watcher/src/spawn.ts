import { join, normalize, sep } from "node:path";
import { SAFE_SKILL_SLUG } from "@project-os/contracts";
import { strFromU8, unzipSync } from "fflate";
import { workerSessionStart } from "@project-os/system-prompts";
import { AGENTS, type Agent, type InstalledSkills } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";

export interface Spawner {
  /** Runs one agent session for `ticketId` when given; resolves with its exit code. */
  spawn(ticketId?: string): Promise<number>;
}

export type SpawnProcess = (
  cmd: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: "inherit";
    stderr: "inherit";
  },
) => { exited: Promise<number> };

/** What the Watcher needs to put a ticket's skill set on disk for one session. */
export interface SkillsIo {
  /**
   * The ticket's skills as a zip (entries `<slug>/<path>`) and the set's name, fetched with
   * this device's secret; undefined when the ticket has none or they can't be had.
   */
  readonly fetchArchive: (
    url: string,
    secret: string,
  ) => Promise<{ readonly set: string; readonly zip: Uint8Array } | undefined>;
  /** A new empty private directory. */
  readonly makeDir: () => string;
  readonly writeFile: (path: string, contents: string) => void;
  readonly removeDir: (path: string) => void;
}

export interface SpawnerIo {
  readonly readFile: (path: string) => string | undefined;
  readonly writePrivate: (path: string, contents: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly configDir: string;
  readonly home: string;
  readonly skills?: SkillsIo;
  readonly log?: (message: string) => void;
}

/** Where a ticket's skill bundle is served: next to the Coordinator's MCP endpoint. */
export const skillsUrl = (mcpUrl: string, ticketId: string): string =>
  `${mcpUrl.replace(/\/mcp\/?$/, "")}/tickets/${encodeURIComponent(ticketId)}/skills`;

/** A file path inside `root`, or undefined when `relative` would climb out of it. */
const inside = (root: string, relative: string): string | undefined => {
  if (relative.startsWith("/") || relative.includes("\\")) return undefined;
  const target = normalize(join(root, relative));
  return target.startsWith(root + sep) ? target : undefined;
};

/**
 * Writes the ticket's skills under a fresh directory for this session. Nothing goes into the
 * user's own agent config, and the caller removes the directory when the session ends.
 */
const installSkills = async (
  config: WatcherConfig,
  io: SpawnerIo,
  agent: Agent,
  ticketId: string,
): Promise<(InstalledSkills & { readonly set: string }) | undefined> => {
  if (!config.skills || !io.skills || agent.skillsLayout === undefined) return undefined;
  const archive = await io.skills
    .fetchArchive(skillsUrl(config.mcpUrl, ticketId), config.secret)
    .catch(() => undefined);
  if (!archive) return undefined;
  const files = (() => {
    try {
      return unzipSync(archive.zip);
    } catch {
      return {};
    }
  })();
  const root = io.skills.makeDir();
  const slugs = new Set<string>();
  for (const [name, bytes] of Object.entries(files)) {
    const [slug, ...rest] = name.split("/");
    if (!slug || !SAFE_SKILL_SLUG.test(slug) || rest.length === 0 || name.endsWith("/")) continue;
    const target = inside(join(root, agent.skillsLayout, slug), rest.join("/"));
    if (!target) continue;
    io.skills.writeFile(target, strFromU8(bytes));
    slugs.add(slug);
  }
  if (slugs.size === 0) {
    io.skills.removeDir(root);
    return undefined;
  }
  io.log?.(`installed ${slugs.size} skill(s) from "${archive.set}" for ${ticketId}`);
  return { root, slugs: [...slugs], set: archive.set };
};

export const bunSpawner = (
  config: WatcherConfig,
  spawnProcess: SpawnProcess,
  io: SpawnerIo,
  agent: Agent = AGENTS[config.agent],
): Spawner => {
  return {
    spawn: async (ticketId) => {
      const skills = ticketId ? await installSkills(config, io, agent, ticketId) : undefined;
      try {
        const prompt = workerSessionStart(config.workerId, ticketId ? { ticketId } : {});
        const launch = agent.launch({
          config,
          prompt,
          configDir: io.configDir,
          home: io.home,
          ...(skills && { skills: { root: skills.root, slugs: skills.slugs } }),
        });
        for (const file of launch.files) {
          io.writePrivate(file.path, file.update(io.readFile(file.path)));
        }
        const proc = spawnProcess([...launch.cmd], {
          cwd: config.cwd,
          env: { ...io.env, ...launch.env },
          stdout: "inherit",
          stderr: "inherit",
        });
        return await proc.exited;
      } finally {
        if (skills) io.skills?.removeDir(skills.root);
      }
    },
  };
};
