import { envNumber, env } from "@project-os/config";
import type { WatcherCredentials } from "./credentials.ts";

export interface WatcherConfig {
  readonly mcpUrl: string;
  readonly workerId: string;
  readonly workerType: "local_claude";
  readonly intervalMs: number;
  readonly maxSessions: number;
  readonly cwd: string;
  /** Bearer secret this device got at registration; every MCP call sends it. */
  readonly secret: string;
}

/**
 * Config for a registered device (credentials saved by `register`): a personal worker serving
 * its owner's tickets, or a shared worker an admin added to the pool.
 */
export const loadConfig = (credentials: WatcherCredentials): WatcherConfig => ({
  mcpUrl: `${credentials.server}/mcp`,
  workerId: credentials.workerId,
  workerType: "local_claude",
  intervalMs: envNumber("POLL_INTERVAL_MS", 5 * 60 * 1000),
  maxSessions: envNumber("MAX_SESSIONS", 1),
  cwd: env("WORKER_CWD", process.cwd()),
  secret: credentials.secret,
});
