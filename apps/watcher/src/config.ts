import { env, envNumber } from "@project-os/config";

export interface WatcherConfig {
  readonly mcpUrl: string;
  readonly workerId: string;
  readonly workerType: "local_claude";
  readonly intervalMs: number;
  readonly maxSessions: number;
  readonly cwd: string;
}

export const loadConfig = (): WatcherConfig => ({
  mcpUrl: env("MCP_URL", "http://localhost:8080/mcp"),
  workerId: env("WORKER_ID", "local-claude"),
  workerType: "local_claude",
  intervalMs: envNumber("POLL_INTERVAL_MS", 5 * 60 * 1000),
  maxSessions: envNumber("MAX_SESSIONS", 1),
  cwd: env("WORKER_CWD", process.cwd()),
});
