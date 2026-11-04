#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { httpMcpClient } from "./mcp-client.ts";
import { createWatcher } from "./poll.ts";
import { bunSpawner } from "./spawn.ts";

// Runs on the host, not in Compose.
const config = loadConfig();
console.log(`watcher ${config.workerId} → ${config.mcpUrl} (every ${config.intervalMs / 1000}s)`);

const watcher = createWatcher({
  config,
  client: httpMcpClient(config.mcpUrl, fetch),
  spawner: bunSpawner(config, Bun.spawn),
  log: console.log,
});

await watcher.pollOnce();
setInterval(() => void watcher.pollOnce(), config.intervalMs);
