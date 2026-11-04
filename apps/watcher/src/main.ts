#!/usr/bin/env bun
import { loadConfig } from "./config.ts";

// Runs on the host, not in Compose. Polling and spawning land in #17.
const config = loadConfig();
console.log(`watcher ${config.workerId} → ${config.mcpUrl} (every ${config.intervalMs / 1000}s)`);
