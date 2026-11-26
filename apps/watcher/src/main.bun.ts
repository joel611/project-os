#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import {
  decodeWorkerTaskType,
  type RunUploadAccepted,
  type RunUploadOutOfOrder,
  TASK_TYPE_HEADER,
} from "@project-os/contracts";
import { parseArgs, USAGE } from "./cli.ts";
import { loadConfig } from "./config.ts";
import {
  configDir,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  writePrivate,
} from "./credentials.ts";
import { gitRunner } from "./git.ts";
import { createLogger, errorMessage } from "./logger.ts";
import { httpMcpClient } from "./mcp-client.ts";
import { createWatcher } from "./poll.ts";
import { killProcessGroup } from "./process-group.ts";
import { registerDevice } from "./register.ts";
import { type RunLogIo, resendSpooled } from "./run-log.ts";
import { sessionLogFiles } from "./session-log.ts";
import { bunSpawner } from "./spawn.ts";
import { uninstallWatcher } from "./uninstall.ts";
import { createWorkspaces } from "./workspace.ts";

// Runs on the host, not in Compose. `project-os-watcher register <code> --server <url>` saves
// this computer's credentials first. A code from /register-worker makes it that person's
// personal worker; an admin's `/register-worker shared:True` code adds it to the pool as a
// shared worker for everyone. It won't run unregistered.
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

let command: ReturnType<typeof parseArgs>;
try {
  command = parseArgs(process.argv.slice(2));
} catch (e) {
  command = fail(e instanceof Error ? e.message : String(e));
}
if (command.kind === "help") {
  console.log(USAGE);
  process.exit(0);
}

if (command.kind === "uninstall") {
  const exit = await uninstallWatcher(
    {
      configDir: configDir(),
      home: homedir(),
      ownPid: process.pid,
      readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
      writeFile: (file, contents) => writeFileSync(file, contents),
      remove: (file) => rmSync(file, { force: true }),
      removeDirIfEmpty: (dir) => {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      },
      watcherPids: async () => {
        const pgrep = Bun.spawn(["pgrep", "-f", "project-os-watcher"], { stdout: "pipe" });
        const out = await new Response(pgrep.stdout).text();
        return out.split("\n").filter(Boolean).map(Number);
      },
      kill: (pid) => process.kill(pid),
      run: async (cmd) => {
        try {
          return await Bun.spawn([...cmd], { stdout: "inherit", stderr: "inherit" }).exited;
        } catch {
          return 127;
        }
      },
      confirm: async () => {
        if (!process.stdin.isTTY) {
          console.error("No terminal to confirm on. Run again with --yes.");
          return false;
        }
        return /^y(es)?$/i.test(prompt("Continue? [y/N]")?.trim() ?? "");
      },
      log: console.log,
    },
    { yes: command.yes },
  );
  process.exit(exit);
}

const logFile = join(configDir(), "logs", "watcher.log");
const logger = createLogger({
  verbose:
    command.verbose ||
    ["1", "true", "on"].includes((process.env.WATCHER_VERBOSE ?? "").toLowerCase()),
  file: logFile,
});
const path = credentialsPath();
if (command.kind === "register") {
  logger.debug("registering", { server: command.server ?? process.env.PROJECT_OS_URL, path });
  const server = command.server ?? process.env.PROJECT_OS_URL;
  if (!server) fail(`register needs --server <coordinator url>.\n\n${USAGE}`);
  try {
    const credentials = await registerDevice(
      {
        server: server!,
        token: command.token,
        ...(command.name && { name: command.name }),
        hostname: hostname(),
      },
      fetch,
    );
    saveCredentials(path, {
      ...credentials,
      ...(command.agent && { agent: command.agent }),
      ...(command.model && { model: command.model }),
    });
    logger.info(`registered as "${credentials.name}" (${credentials.workerId}); saved ${path}`);
  } catch (e) {
    fail(errorMessage(e));
  }
}

const credentials = loadCredentials(path);
if (!credentials) {
  fail(`This computer isn't registered yet (no ${path}).\n\n${USAGE}`);
}
const loaded = loadConfig(credentials!, (name) => Bun.which(name) !== null);
// `--no-run-log` wins over the environment.
const config = command.runLog ? loaded : { ...loaded, runLog: false };
if (credentials!.agent && config.agent !== credentials!.agent && !process.env.WATCHER_AGENT) {
  logger.warn(`saved agent ${credentials!.agent} isn't installed; using ${config.agent} instead`);
}
const banner = String.raw`
  ____            _           _      ___  ____
 |  _ \ _ __ ___ (_) ___  ___| |_   / _ \/ ___|
 | |_) | '__/ _ \| |/ _ \/ __| __| | | | \___ \
 |  __/| | | (_) | |  __/ (__| |_  | |_| |___) |
 |_|   |_|  \___// |\___|\___|\__|  \___/|____/
               |__/`;
const server = URL.parse(credentials!.server);
// Log the base URL without any user info, query parameters, or fragment.
const coordinator =
  server && (server.protocol === "https:" || server.protocol === "http:")
    ? `${server.origin}${server.pathname}`
    : "(invalid URL)";
const acp = config.agent === "pi" && config.piAcp;
const workspacesDir = join(configDir(), "workspaces");
const sessionLogsDir = join(configDir(), "logs", "sessions");
logger.info(banner, {
  coordinator,
  workerId: config.workerId,
  agent: config.agent,
  acp: acp ? "on" : "off",
  model: config.model || (acp && process.env.PI_ACP_MODEL) || "agent default",
  intervalMs: config.intervalMs,
  workspaces: workspacesDir,
  logFile,
  sessionLogs: sessionLogsDir,
});
logger.debug("config", {
  agent: config.agent,
  model: config.model,
  maxSessions: config.maxSessions,
  intervalMs: config.intervalMs,
  skills: config.skills,
  runLog: config.runLog,
  gitTimeoutMs: config.gitTimeoutMs,
  credentials: path,
});

/** Values from this computer's environment that look like credentials, to mask in run logs. */
const envSecrets = Object.entries(process.env)
  .filter(
    ([name, value]) =>
      /(TOKEN|SECRET|KEY|PASSWORD|PASSWD)/i.test(name) && (value ?? "").length >= 8,
  )
  .map(([, value]) => value!);

const spoolDir = join(configDir(), "run-spool");
const runLog: RunLogIo = {
  post: async (url, secret, upload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(upload),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as Partial<RunUploadAccepted>;
      return {
        ok: true,
        nextSeq: typeof body.nextSeq === "number" ? body.nextSeq : upload.seq + 1,
      };
    }
    const body = (await res.json().catch(() => ({}))) as Partial<RunUploadOutOfOrder>;
    return {
      ok: false,
      status: res.status,
      ...(typeof body.expected === "number" && { expected: body.expected }),
    };
  },
  spool: {
    write: (name, contents) => writePrivate(join(spoolDir, name), contents),
    list: () =>
      existsSync(spoolDir)
        ? readdirSync(spoolDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => ({ name, contents: readFileSync(join(spoolDir, name), "utf8") }))
        : [],
    remove: (name) => rmSync(join(spoolDir, name), { force: true }),
  },
  flushEveryMs: 3_000,
  sleep: (ms) => Bun.sleep(ms),
};
const sendSpooled = () =>
  config.runLog
    ? resendSpooled(runLog, config.secret, logger).then(
        (n) => n > 0 && logger.info(`sent ${n} saved run log(s)`),
        () => undefined,
      )
    : undefined;

const git = gitRunner({ timeoutMs: config.gitTimeoutMs });
// Each git command leads its own process group, so the terminal's Ctrl-C doesn't reach it.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    git.stopAll();
    process.exit(code);
  });
}
const workspaces = createWorkspaces({ root: workspacesDir, git: git.run, env: process.env });

const client = httpMcpClient(config.mcpUrl, fetch, config.secret, logger);
const watcher = createWatcher({
  config,
  client,
  workspaces,
  spawner: bunSpawner(
    config,
    (cmd, options) => {
      // Only a session that can be force-stopped (run log on) gets its own process group, so
      // otherwise Ctrl-C still reaches the agent.
      const proc = Bun.spawn(cmd, {
        ...options,
        stdout: "pipe",
        stderr: "pipe",
        detached: config.runLog,
      });
      return {
        exited: proc.exited,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: () => killProcessGroup(proc),
      };
    },
    {
      readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
      writePrivate,
      spawnAcp: (cmd, options) => {
        const proc = Bun.spawn(cmd, {
          ...options,
          detached: config.runLog,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exited: proc.exited,
          stdout: proc.stdout,
          stderr: proc.stderr,
          stdin: new WritableStream<Uint8Array>({
            write: (chunk) => void proc.stdin.write(chunk),
            close: () => void proc.stdin.end(),
          }),
          kill: (signal) => (signal === "SIGKILL" ? killProcessGroup(proc) : proc.kill()),
        };
      },
      env: process.env,
      configDir: configDir(),
      home: homedir(),
      mcp: client,
      workspaces,
      sessions: {
        newRunId: () => crypto.randomUUID(),
        now: () => new Date(),
        secrets: envSecrets,
        terminal: {
          out: (text) => void process.stdout.write(text),
          err: (text) => void process.stderr.write(text),
        },
        openLog: sessionLogFiles(sessionLogsDir),
      },
      logger,
      ...(config.runLog && { runLog }),
      fetchStop: async (url, secret, signal) => {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${secret}` },
          signal,
          cache: "no-store",
        });
        return res.ok && ((await res.json()) as { stop?: unknown }).stop === true;
      },
      skills: {
        fetchArchive: async (url, secret) => {
          const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
          logger.debug("skills: archive response", { status: res.status });
          // 204: the ticket has no skills.
          return res.status === 200
            ? {
                set: decodeURIComponent(res.headers.get(TASK_TYPE_HEADER) ?? ""),
                zip: new Uint8Array(await res.arrayBuffer()),
              }
            : undefined;
        },
        fetchTaskType: async (url, secret) => {
          const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
          logger.debug("task type: response", { status: res.status });
          // 204: the ticket has no task type.
          if (res.status !== 200) return undefined;
          return decodeWorkerTaskType(await res.json());
        },
        // One private directory per session, removed when it ends.
        makeDir: () => mkdtempSync(join(tmpdir(), "project-os-skills-")),
        writeFile: (file, contents) => {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, contents, { mode: 0o600 });
        },
        removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      },
    },
  ),
  logger,
});

await watcher.pollOnce();
void sendSpooled();
setInterval(() => {
  void watcher.pollOnce();
  void sendSpooled();
}, config.intervalMs);
