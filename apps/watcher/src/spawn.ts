import { join, normalize, sep } from "node:path";
import { SAFE_SKILL_SLUG, type SkillBundle } from "@project-os/contracts";
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
  /** The ticket's bundle, fetched with this device's secret; undefined when it can't be had. */
  readonly fetchBundle: (url: string, secret: string) => Promise<SkillBundle | undefined>;
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
  const bundle = await io.skills
    .fetchBundle(skillsUrl(config.mcpUrl, ticketId), config.secret)
    .catch(() => undefined);
  if (!bundle || !bundle.set || bundle.skills.length === 0) return undefined;
  const root = io.skills.makeDir();
  const slugs: string[] = [];
  for (const skill of bundle.skills) {
    if (!SAFE_SKILL_SLUG.test(skill.slug)) continue;
    const folder = join(root, agent.skillsLayout, skill.slug);
    for (const file of skill.files) {
      const target = inside(folder, file.path);
      if (target) io.skills.writeFile(target, file.contents);
    }
    slugs.push(skill.slug);
  }
  if (slugs.length === 0) {
    io.skills.removeDir(root);
    return undefined;
  }
  io.log?.(`installed ${slugs.length} skill(s) from "${bundle.set.name}" for ${ticketId}`);
  return { root, slugs, set: bundle.set.name };
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
