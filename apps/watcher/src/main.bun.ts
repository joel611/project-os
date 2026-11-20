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
import { parseArgs, USAGE } from "./cli.ts";
import { loadConfig } from "./config.ts";
import {
  configDir,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  writePrivate,
} from "./credentials.ts";
import { createLogger, errorMessage } from "./logger.ts";
import { httpMcpClient } from "./mcp-client.ts";
import { createWatcher } from "./poll.ts";
import { registerDevice } from "./register.ts";
import { bunSpawner } from "./spawn.ts";
import { uninstallWatcher } from "./uninstall.ts";

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

const logger = createLogger({
  verbose:
    command.verbose ||
    ["1", "true", "on"].includes((process.env.WATCHER_VERBOSE ?? "").toLowerCase()),
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
const config = loadConfig(credentials!, (name) => Bun.which(name) !== null);
if (credentials!.agent && config.agent !== credentials!.agent && !process.env.WATCHER_AGENT) {
  logger.warn(`saved agent ${credentials!.agent} isn't installed; using ${config.agent} instead`);
}
logger.info(
  `watcher ${config.workerId} (${config.agent}) → ${config.mcpUrl} (every ${config.intervalMs / 1000}s)`,
);
logger.debug("config", {
  agent: config.agent,
  model: config.model,
  maxSessions: config.maxSessions,
  intervalMs: config.intervalMs,
  cwd: config.cwd,
  skills: config.skills,
  credentials: path,
});

const watcher = createWatcher({
  config,
  client: httpMcpClient(config.mcpUrl, fetch, config.secret, logger),
  spawner: bunSpawner(config, Bun.spawn, {
    readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
    writePrivate,
    env: process.env,
    configDir: configDir(),
    home: homedir(),
    logger,
    skills: {
      fetchArchive: async (url, secret) => {
        const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
        logger.debug("skills: archive response", { status: res.status });
        // 204: the ticket has no skills.
        return res.status === 200
          ? {
              set: decodeURIComponent(res.headers.get("x-task-type") ?? ""),
              zip: new Uint8Array(await res.arrayBuffer()),
            }
          : undefined;
      },
      fetchTaskType: async (url, secret) => {
        const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
        logger.debug("task type: response", { status: res.status });
        // 204: the ticket has no task type.
        if (res.status !== 200) return undefined;
        const body = (await res.json()) as { name?: unknown; instructions?: unknown };
        return typeof body.name === "string" && typeof body.instructions === "string"
          ? { name: body.name, instructions: body.instructions }
          : undefined;
      },
      // One private directory per session, removed when it ends.
      makeDir: () => mkdtempSync(join(tmpdir(), "project-os-skills-")),
      writeFile: (file, contents) => {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, contents, { mode: 0o600 });
      },
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    },
  }),
  logger,
});

await watcher.pollOnce();
setInterval(() => void watcher.pollOnce(), config.intervalMs);
