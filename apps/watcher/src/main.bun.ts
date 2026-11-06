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

// Runs on the host, not in Compose. Two modes:
// - personal: `project-os-watcher register <code> --server <url>` saves this computer's
//   credentials; it then serves only the tickets of whoever ran /register-worker.
// - shared (no credentials saved): env MCP_URL / WORKER_ID, no auth, as before.
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
const config = loadConfig(credentials);
console.log(
  `watcher ${config.workerId} ${credentials ? "(personal)" : "(shared)"} → ${config.mcpUrl} (every ${config.intervalMs / 1000}s)`,
);

// Claude Code reads the MCP config from a file only this user can read, so the secret never
// shows up in the process list.
const mcpConfigFile = config.secret ? join(configDir(), "mcp.json") : undefined;
if (mcpConfigFile) writePrivate(mcpConfigFile, mcpConfigJson(config));

const watcher = createWatcher({
  config,
  client: httpMcpClient(config.mcpUrl, fetch, config.secret),
  spawner: bunSpawner(config, Bun.spawn, mcpConfigFile ? { mcpConfigFile } : {}),
  log: console.log,
});

await watcher.pollOnce();
setInterval(() => void watcher.pollOnce(), config.intervalMs);
