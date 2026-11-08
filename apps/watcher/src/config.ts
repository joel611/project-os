import { envNumber, env } from "@project-os/config";
import { AGENT_NAMES, type AgentName, isAgentName } from "./agents.ts";
import type { WatcherCredentials } from "./credentials.ts";

export interface WatcherConfig {
  readonly mcpUrl: string;
  readonly workerId: string;
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

/** `WATCHER_AGENT`, else what `register --agent` saved, else Claude. */
const loadAgent = (credentials: WatcherCredentials): AgentName => {
  const name = process.env.WATCHER_AGENT ?? credentials.agent ?? "claude";
  if (!isAgentName(name)) {
    throw new Error(`WATCHER_AGENT must be one of ${AGENT_NAMES.join(", ")} (got "${name}")`);
  }
  return name;
};

/**
 * Config for a registered device (credentials saved by `register`): a personal worker serving
 * its owner's tickets, or a shared worker an admin added to the pool.
 */
export const loadConfig = (credentials: WatcherCredentials): WatcherConfig => ({
  mcpUrl: `${credentials.server}/mcp`,
  workerId: credentials.workerId,
  workerType: "local_claude",
  agent: loadAgent(credentials),
  ...((process.env.WATCHER_MODEL || credentials.model) && {
    model: process.env.WATCHER_MODEL || credentials.model,
  }),
  intervalMs: envNumber("POLL_INTERVAL_MS", 5 * 60 * 1000),
  maxSessions: envNumber("MAX_SESSIONS", 1),
  cwd: env("WORKER_CWD", process.cwd()),
  secret: credentials.secret,
});
