#!/usr/bin/env bun
import { hostname } from "node:os";
import { join } from "node:path";
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
import { bunSpawner, mcpConfigJson } from "./spawn.ts";

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
    saveCredentials(path, credentials);
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
console.log(`watcher ${config.workerId} → ${config.mcpUrl} (every ${config.intervalMs / 1000}s)`);

// Claude Code reads the MCP config from a file only this user can read, so the secret never
// shows up in the process list.
const mcpConfigFile = join(configDir(), "mcp.json");
writePrivate(mcpConfigFile, mcpConfigJson(config));

const watcher = createWatcher({
  config,
  client: httpMcpClient(config.mcpUrl, fetch, config.secret),
  spawner: bunSpawner(config, Bun.spawn, { mcpConfigFile }),
  log: console.log,
});

await watcher.pollOnce();
setInterval(() => void watcher.pollOnce(), config.intervalMs);
