import { DEFAULT_WORKER_ID, env, envNumber } from "@project-os/config";
import type { WatcherCredentials } from "./credentials.ts";

export interface WatcherConfig {
  readonly mcpUrl: string;
  readonly workerId: string;
  readonly workerType: "local_claude";
  readonly intervalMs: number;
  readonly maxSessions: number;
  readonly cwd: string;
  /** Bearer secret of a personal worker. Absent: the shared worker, which sends none. */
  readonly secret?: string;
}

/**
 * Registered (credentials saved by `register`): a personal worker serving only its owner's
 * tickets. Otherwise the shared worker from env (MCP_URL, WORKER_ID), as before.
 */
export const loadConfig = (credentials?: WatcherCredentials): WatcherConfig => ({
  mcpUrl: credentials ? `${credentials.server}/mcp` : env("MCP_URL", "http://localhost:8080/mcp"),
  workerId: credentials ? credentials.workerId : env("WORKER_ID", DEFAULT_WORKER_ID),
  workerType: "local_claude",
  intervalMs: envNumber("POLL_INTERVAL_MS", 5 * 60 * 1000),
  maxSessions: envNumber("MAX_SESSIONS", 1),
  cwd: env("WORKER_CWD", process.cwd()),
  ...(credentials && { secret: credentials.secret }),
});
