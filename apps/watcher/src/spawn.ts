import { join, normalize, sep } from "node:path";
import { SAFE_SKILL_SLUG } from "@project-os/contracts";
import { strFromU8, unzipSync } from "fflate";
import { workerSessionStart } from "@project-os/system-prompts";
import { AGENTS, type Agent, type InstalledSkills } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";
import { errorMessage, type Logger, silentLogger } from "./logger.ts";
import { outputEvent, terminalText } from "./run-events.ts";
import { createRunRecorder, type RunLogIo, runsUrl } from "./run-log.ts";

export interface Spawner {
  /** Runs one agent session for `ticketId` when given; resolves with its exit code. */
  spawn(ticketId?: string): Promise<number>;
}

export type SpawnProcess = (
  cmd: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    /** `pipe` when the session is being logged: the Watcher reads the output and passes it on. */
    stdout: "inherit" | "pipe";
    stderr: "inherit" | "pipe";
  },
) => {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null | undefined;
  stderr?: ReadableStream<Uint8Array> | null | undefined;
};

/** What the Watcher needs to put a ticket's task type on disk for one session. */
export interface SkillsIo {
  /**
   * The ticket's skills as a zip (entries `<slug>/<path>`) and the set's name, fetched with
   * this device's secret; undefined when the ticket has none or they can't be had.
   */
  readonly fetchArchive: (
    url: string,
    secret: string,
  ) => Promise<{ readonly set: string; readonly zip: Uint8Array } | undefined>;
  /**
   * The ticket's task type, with the instructions that go into the session's prompt; undefined
   * when the ticket has none or it can't be had.
   */
  readonly fetchTaskType: (
    url: string,
    secret: string,
  ) => Promise<{ readonly name: string; readonly instructions: string } | undefined>;
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
  /** Where run logs go. Without it (or with `config.runLog` off) a session is not recorded. */
  readonly runLog?: RunLogIo;
  readonly logger?: Logger;
  /** Where the agent's output is shown. Default: this process's stdout and stderr. */
  readonly terminal?: {
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  };
}

/** Calls `onLine` for each line of `stream`, and for a last line that ends without a newline. */
const readLines = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  }
  pending += decoder.decode();
  if (pending !== "") onLine(pending);
};

/** Where a ticket's skill bundle is served: next to the Coordinator's MCP endpoint. */
export const skillsUrl = (mcpUrl: string, ticketId: string): string =>
  `${mcpUrl.replace(/\/mcp\/?$/, "")}/tickets/${encodeURIComponent(ticketId)}/skills`;

/** Where a ticket's task type is served, next to the skill bundle. */
export const taskTypeUrl = (mcpUrl: string, ticketId: string): string =>
  `${mcpUrl.replace(/\/mcp\/?$/, "")}/tickets/${encodeURIComponent(ticketId)}/task-type`;
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
  const logger = io.logger ?? silentLogger;
  if (!config.skills || !io.skills || agent.skillsLayout === undefined) {
    logger.debug("skills: skipped", { ticketId, enabled: config.skills, agent: config.agent });
    return undefined;
  }
  const archive = await io.skills
    .fetchArchive(skillsUrl(config.mcpUrl, ticketId), config.secret)
    .catch((e: unknown) => {
      logger.warn(`skills: fetch failed: ${errorMessage(e)}`, { ticketId });
      return undefined;
    });
  if (!archive) {
    logger.debug("skills: none for this ticket", { ticketId });
    return undefined;
  }
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
    if (!target) {
      logger.warn(`skills: skipped unsafe path "${name}"`, { ticketId });
      continue;
    }
    io.skills.writeFile(target, strFromU8(bytes));
    slugs.add(slug);
  }
  if (slugs.size === 0) {
    io.skills.removeDir(root);
    return undefined;
  }
  logger.info(`installed ${slugs.size} skill(s) from "${archive.set}" for ${ticketId}`, {
    ticketId,
    slugs: [...slugs],
  });
  return { root, slugs: [...slugs], set: archive.set };
};

export const bunSpawner = (
  config: WatcherConfig,
  spawnProcess: SpawnProcess,
  io: SpawnerIo,
  agent: Agent = AGENTS[config.agent],
): Spawner => {
  const logger = io.logger ?? silentLogger;
  return {
    spawn: async (ticketId) => {
      const skills = ticketId ? await installSkills(config, io, agent, ticketId) : undefined;
      const taskType =
        ticketId && config.skills && io.skills
          ? await io.skills
              .fetchTaskType(taskTypeUrl(config.mcpUrl, ticketId), config.secret)
              .catch((e: unknown) => {
                logger.warn(`task type: fetch failed: ${errorMessage(e)}`, { ticketId });
                return undefined;
              })
          : undefined;
      // A session is recorded when the device allows it and the ticket is known.
      const recorder =
        ticketId && config.runLog && io.runLog
          ? createRunRecorder({
              io: io.runLog,
              url: runsUrl(config.mcpUrl, ticketId),
              secret: config.secret,
              agent: config.agent,
              ...(config.model && { model: config.model }),
              logger,
            })
          : undefined;
      try {
        const prompt = workerSessionStart(config.workerId, {
          ...(ticketId && { ticketId }),
          ...(taskType && { taskType }),
        });
        const launch = agent.launch({
          config,
          prompt,
          configDir: io.configDir,
          home: io.home,
          ...(skills && { skills: { root: skills.root, slugs: skills.slugs } }),
          ...(recorder && agent.parser && { structuredOutput: true }),
        });
        for (const file of launch.files) {
          io.writePrivate(file.path, file.update(io.readFile(file.path)));
        }
        logger.debug(`launching ${config.agent}`, {
          ticketId,
          command: launch.cmd[0],
          argCount: launch.cmd.length - 1,
          cwd: config.cwd,
          model: config.model,
          skills: skills?.slugs.length ?? 0,
          files: launch.files.map((file) => file.path),
        });
        const proc = spawnProcess([...launch.cmd], {
          cwd: config.cwd,
          env: { ...io.env, ...launch.env },
          stdout: recorder ? "pipe" : "inherit",
          stderr: recorder ? "pipe" : "inherit",
        });
        if (!recorder) return await proc.exited;
        const out = io.terminal?.out ?? ((text: string) => void process.stdout.write(text));
        const err = io.terminal?.err ?? ((text: string) => void process.stderr.write(text));
        const parse = agent.parser?.();
        const at = () => (io.runLog?.now() ?? new Date()).toISOString();
        const reads = [
          proc.stdout &&
            readLines(proc.stdout, (line) => {
              const events = parse ? parse(line, at()) : [outputEvent(line, at(), "stdout")];
              for (const event of events) {
                recorder.push(event);
                const shown = parse ? terminalText(event) : line;
                if (shown !== undefined) out(`${shown}\n`);
              }
              if (!parse && events.length === 0) out(`${line}\n`);
            }),
          proc.stderr &&
            readLines(proc.stderr, (line) => {
              recorder.push(outputEvent(line, at(), "stderr"));
              err(`${line}\n`);
            }),
        ].filter((read) => read !== undefined && read !== null);
        const exitCode = await proc.exited;
        // The last lines can arrive after the process has exited.
        await Promise.allSettled(reads);
        recorder.push({
          at: at(),
          type: exitCode === 0 ? "lifecycle" : "error",
          text: `${config.agent} exited with code ${exitCode}.`,
        });
        await recorder.finish(exitCode);
        return exitCode;
      } finally {
        if (skills) io.skills?.removeDir(skills.root);
      }
    },
  };
};
