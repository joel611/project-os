import { join, normalize, sep } from "node:path";
import { SAFE_SKILL_SLUG, type WorkerTaskType, workerTicketUrl } from "@project-os/contracts";
import { strFromU8, unzipSync } from "fflate";
import { type SessionWorkspace, workerSessionStart } from "@project-os/system-prompts";
import { type AcpProcess, runAcpSession } from "./acp-run.ts";
import { AGENTS, type Agent, type InstalledSkills } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";
import { errorMessage, type Logger, silentLogger } from "./logger.ts";
import type { McpClient } from "./poll.ts";
import { outputEvent, terminalText } from "./run-events.ts";
import { createRunRecorder, type RunLogIo, runUploadSink } from "./run-log.ts";
import { type FetchRunStop, watchRunStop } from "./run-stop.ts";
import { type OpenSessionLog, sessionLogSink } from "./session-log.ts";
import type { RepoSource, Workspaces } from "./workspace.ts";

/** An assigned ticket, as `ticket_list_assigned` lists it. */
export interface SessionTicket {
  readonly id: string;
  readonly projectId: string;
  readonly assignedAt?: string | null;
}

export interface Spawner {
  /** Runs one agent session for `ticket`; resolves with its exit code. */
  spawn(ticket: SessionTicket): Promise<number>;
}

/**
 * Starts the agent with its stdout and stderr piped: the Watcher reads every line into the
 * session's log and shows it on the terminal.
 */
export type SpawnProcess = (
  cmd: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => {
  exited: Promise<number>;
  kill?: (signal: "SIGKILL") => void;
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
  readonly fetchTaskType: (url: string, secret: string) => Promise<WorkerTaskType | undefined>;
  /** A new empty private directory. */
  readonly makeDir: () => string;
  readonly writeFile: (path: string, contents: string) => void;
  readonly removeDir: (path: string) => void;
}

/** Starts a program whose stdin and stdout carry ACP; the Watcher's own stdio is not used. */
export type SpawnAcp = (
  cmd: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => AcpProcess;

/** How a session is recorded and shown, whether or not it is also uploaded. */
export interface SessionIo {
  readonly newRunId: () => string;
  readonly now: () => Date;
  /** Values to mask exactly, besides the device secret (the environment's tokens and keys). */
  readonly secrets: readonly string[];
  /** Where the agent's output is shown while the session runs. */
  readonly terminal: {
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  };
  /** Opens the session's own log file (`<configDir>/logs/sessions/<ticketId>/<name>`). */
  readonly openLog: OpenSessionLog;
}

export interface SpawnerIo {
  /** Starts Pi's ACP program. Without it `config.piAcp` is ignored and Pi runs as a CLI. */
  readonly spawnAcp?: SpawnAcp;
  readonly readFile: (path: string) => string | undefined;
  readonly writePrivate: (path: string, contents: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly configDir: string;
  readonly home: string;
  /** The Coordinator's MCP, for the ticket's repos and the person's GitHub token. */
  readonly mcp: McpClient;
  /** Where each ticket's repos are checked out; the session starts there. */
  readonly workspaces: Pick<Workspaces, "prepare">;
  readonly sessions: SessionIo;
  readonly skills?: SkillsIo;
  /** Where run logs are uploaded. Without it (or with `config.runLog` off) they stay local. */
  readonly runLog?: RunLogIo;
  readonly fetchStop?: FetchRunStop;
  readonly logger?: Logger;
}

/** Calls `onLine` for each line of `stream`, and for a last line that ends without a newline. */
const readLines = async (
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void,
): Promise<void> => {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  }
  pending += decoder.decode();
  if (pending !== "") onLine(pending);
};

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
    .fetchArchive(workerTicketUrl(config.mcpUrl, "skills", ticketId), config.secret)
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

/**
 * The ticket's folder with the project's GitHub repos checked out in it, and the person's GitHub
 * token when it was needed for that. Sources that can't be listed or repos that can't be checked
 * out don't stop the session: the prompt says what is missing.
 */
const openWorkspace = async (
  io: SpawnerIo,
  ticket: SessionTicket,
): Promise<{ readonly workspace: SessionWorkspace; readonly githubToken?: string }> => {
  const logger = io.logger ?? silentLogger;
  const fields = { ticketId: ticket.id };
  let repos: RepoSource[] = [];
  let sourcesError: string | undefined;
  try {
    const out = (await io.mcp.callTool("project_sources_list", {
      projectId: ticket.projectId,
    })) as {
      readonly sources: ReadonlyArray<{
        readonly type?: unknown;
        readonly alias?: unknown;
        readonly externalId?: unknown;
      }>;
    };
    repos = out.sources.flatMap((s) =>
      s.type === "github_repo" && typeof s.alias === "string" && typeof s.externalId === "string"
        ? [{ alias: s.alias, repo: s.externalId }]
        : [],
    );
  } catch (e) {
    sourcesError = errorMessage(e).slice(0, 200);
    logger.warn(`workspace: could not list the project's sources: ${sourcesError}`, fields);
  }
  let githubToken: string | undefined;
  const workspace = await io.workspaces.prepare({
    ticketId: ticket.id,
    repos,
    githubToken: async () => {
      const out = (await io.mcp.callTool("user_token", {
        ticketId: ticket.id,
        provider: "github",
      })) as { readonly accessToken?: unknown };
      if (typeof out.accessToken !== "string" || out.accessToken === "") {
        throw new Error("user_token returned no token");
      }
      githubToken = out.accessToken;
      return githubToken;
    },
  });
  for (const repo of workspace.failed) {
    logger.warn(`workspace: ${repo.alias} (${repo.repo}) not checked out: ${repo.reason}`, fields);
  }
  logger.info(`workspace: ${workspace.checkouts.length} repo(s) checked out for ${ticket.id}`, {
    ...fields,
    cwd: workspace.cwd,
  });
  return {
    workspace: { ...workspace, ...(sourcesError !== undefined && { sourcesError }) },
    ...(githubToken !== undefined && { githubToken }),
  };
};

export const bunSpawner = (
  config: WatcherConfig,
  spawnProcess: SpawnProcess,
  io: SpawnerIo,
  agent: Agent = AGENTS[config.agent],
): Spawner => {
  const logger = io.logger ?? silentLogger;
  return {
    spawn: async (ticket) => {
      const ticketId = ticket.id;
      const { assignedAt } = ticket;
      const { workspace, githubToken } = await openWorkspace(io, ticket);
      const { cwd } = workspace;
      const skills = await installSkills(config, io, agent, ticketId);
      const taskType =
        config.skills && io.skills
          ? await io.skills
              .fetchTaskType(workerTicketUrl(config.mcpUrl, "taskType", ticketId), config.secret)
              .catch((e: unknown) => {
                logger.warn(`task type: fetch failed: ${errorMessage(e)}`, { ticketId });
                return undefined;
              })
          : undefined;
      const { sessions } = io;
      const at = () => sessions.now().toISOString();
      const { out, err } = sessions.terminal;
      const runId = sessions.newRunId();
      const startedAt = at();
      // Every session goes to its own log file; it is also uploaded when the device allows it.
      const upload =
        config.runLog && io.runLog
          ? runUploadSink({
              io: io.runLog,
              runId,
              startedAt,
              url: workerTicketUrl(config.mcpUrl, "runs", ticketId),
              secret: config.secret,
              agent: config.agent,
              ...(assignedAt && io.fetchStop && { assignedAt }),
              ...(config.model && { model: config.model }),
              logger,
            })
          : undefined;
      const recorder = createRunRecorder({
        runId,
        secrets: [
          config.secret,
          ...sessions.secrets,
          ...(githubToken ? [githubToken, btoa(`x-access-token:${githubToken}`)] : []),
        ],
        sinks: [
          sessionLogSink(
            () => sessions.openLog(ticketId, `${startedAt.replaceAll(":", "-")}-${runId}.log`),
            logger,
          ),
          ...(upload ? [upload] : []),
        ],
      });
      const monitor = (exited: Promise<number>, kill?: () => void) => {
        if (!assignedAt || !upload || !io.fetchStop || !kill) return;
        recorder.push({ at: at(), type: "lifecycle", text: "Worker process started." });
        const close = watchRunStop({
          mcpUrl: config.mcpUrl,
          secret: config.secret,
          ticketId,
          runId: recorder.runId,
          fetchStop: io.fetchStop,
          stop: () => {
            logger.info("Force stop received; killing the agent process", {
              ticketId,
              runId: recorder.runId,
            });
            kill();
          },
        });
        void exited.then(close, close);
      };
      try {
        const prompt = workerSessionStart(config.workerId, {
          ticketId,
          ...(taskType && { taskType }),
          workspace,
        });
        if (config.piAcp && agent.name === "pi" && io.spawnAcp) {
          const proc = io.spawnAcp([...config.piAcpCommand], {
            cwd,
            env: {
              ...io.env,
              ...(config.model && { PI_ACP_MODEL: config.model }),
              ...(skills && {
                PI_ACP_SKILL_PATHS: skills.slugs
                  .map((slug) => join(skills.root, "skills", slug))
                  .join(":"),
              }),
            },
          });
          monitor(proc.exited, () => proc.kill("SIGKILL"));
          const errors = readLines(proc.stderr, (line) => {
            recorder.push(outputEvent(line, at(), "stderr"));
            err(`${line}\n`);
          });
          const exitCode = await runAcpSession({
            process: proc,
            cwd,
            prompt,
            mcpUrl: config.mcpUrl,
            secret: config.secret,
            now: at,
            onEvent: (event) => {
              recorder.push(event);
              const shown = terminalText(event);
              if (shown !== undefined) out(`${shown}\n`);
            },
          });
          await Promise.allSettled([errors]);
          await recorder.finish(exitCode);
          return exitCode;
        }
        const launch = agent.launch({
          config,
          prompt,
          configDir: io.configDir,
          home: io.home,
          ...(skills && { skills: { root: skills.root, slugs: skills.slugs } }),
          ...(agent.parser && { structuredOutput: true }),
        });
        for (const file of launch.files) {
          io.writePrivate(file.path, file.update(io.readFile(file.path)));
        }
        logger.debug(`launching ${config.agent}`, {
          ticketId,
          command: launch.cmd[0],
          argCount: launch.cmd.length - 1,
          cwd,
          model: config.model,
          skills: skills?.slugs.length ?? 0,
          files: launch.files.map((file) => file.path),
        });
        const proc = spawnProcess([...launch.cmd], { cwd, env: { ...io.env, ...launch.env } });
        monitor(proc.exited, proc.kill ? () => proc.kill!("SIGKILL") : undefined);
        const parse = agent.parser?.();
        const reads = [
          readLines(proc.stdout, (line) => {
            const events = parse ? parse(line, at()) : [outputEvent(line, at(), "stdout")];
            for (const event of events) {
              recorder.push(event);
              const shown = parse ? terminalText(event) : line;
              if (shown !== undefined) out(`${shown}\n`);
            }
          }),
          readLines(proc.stderr, (line) => {
            recorder.push(outputEvent(line, at(), "stderr"));
            err(`${line}\n`);
          }),
        ];
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
      } catch (e) {
        recorder.push({
          at: at(),
          type: "error",
          text: `${config.agent} could not start: ${errorMessage(e)}`,
        });
        await recorder.finish(127);
        throw e;
      } finally {
        if (skills) io.skills?.removeDir(skills.root);
      }
    },
  };
};
