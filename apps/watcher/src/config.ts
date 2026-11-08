import { envNumber, env } from "@project-os/config";
import { AGENT_NAMES, type AgentName, isAgentName } from "./agents.ts";
import type { WatcherCredentials } from "./credentials.ts";

export interface WatcherConfig {
  readonly mcpUrl: string;
  readonly workerId: string;
  /** What the Coordinator assigns by (the type this device registered as). Same for every agent. */
  readonly workerType: "local_claude";
  /** Which agent CLI runs a session (`WATCHER_AGENT`). */
  readonly agent: AgentName;
  /** Passed to the agent as `--model` (`WATCHER_MODEL`); unset uses the agent's own default. */
  readonly model?: string;
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
const loadAgent = (): AgentName => {
  const name = env("WATCHER_AGENT", "claude");
  if (!isAgentName(name)) {
    throw new Error(`WATCHER_AGENT must be one of ${AGENT_NAMES.join(", ")} (got "${name}")`);
  }
  return name;
};

export const loadConfig = (credentials: WatcherCredentials): WatcherConfig => ({
  mcpUrl: `${credentials.server}/mcp`,
  workerId: credentials.workerId,
  workerType: "local_claude",
  agent: loadAgent(),
  ...(process.env.WATCHER_MODEL && { model: process.env.WATCHER_MODEL }),
  intervalMs: envNumber("POLL_INTERVAL_MS", 5 * 60 * 1000),
  maxSessions: envNumber("MAX_SESSIONS", 1),
  cwd: env("WORKER_CWD", process.cwd()),
  secret: credentials.secret,
});
