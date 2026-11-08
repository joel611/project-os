#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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

const path = credentialsPath();
if (command.kind === "register") {
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
    console.log(`registered as "${credentials.name}" (${credentials.workerId}); saved ${path}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

const credentials = loadCredentials(path);
if (!credentials) {
  fail(`This computer isn't registered yet (no ${path}).\n\n${USAGE}`);
}
const config = loadConfig(credentials!);
console.log(
  `watcher ${config.workerId} (${config.agent}) → ${config.mcpUrl} (every ${config.intervalMs / 1000}s)`,
);

const watcher = createWatcher({
  config,
  client: httpMcpClient(config.mcpUrl, fetch, config.secret),
  spawner: bunSpawner(config, Bun.spawn, {
    readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
    writePrivate,
    env: process.env,
    configDir: configDir(),
    home: homedir(),
  }),
  log: console.log,
});

await watcher.pollOnce();
setInterval(() => void watcher.pollOnce(), config.intervalMs);
