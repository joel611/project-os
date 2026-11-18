import { envNumber, env } from "@project-os/config";
import { AGENT_NAMES, type AgentName, isAgentName } from "./agents.ts";
import type { WatcherCredentials } from "./credentials.ts";

export interface WatcherConfig {
  readonly mcpUrl: string;
  readonly workerId: string;
  readonly workerType: "local";
  /** Which agent CLI runs a session (`WATCHER_AGENT`). */
  readonly agent: AgentName;
  /** Passed to the agent as `--model` (`WATCHER_MODEL`); unset uses the agent's own default. */
  readonly model?: string;
  readonly intervalMs: number;
  readonly maxSessions: number;
  readonly cwd: string;
  /** Bearer secret this device got at registration; every MCP call sends it. */
  readonly secret: string;
  /** Install the ticket's skill set before a session starts (`WATCHER_SKILLS=0` turns it off). */
  readonly skills: boolean;
}

const loadAgent = (
  credentials: WatcherCredentials,
  hasCommand: (command: string) => boolean,
): AgentName => {
  const forced = process.env.WATCHER_AGENT;
  if (forced !== undefined) {
    if (!isAgentName(forced)) {
      throw new Error(`WATCHER_AGENT must be one of ${AGENT_NAMES.join(", ")} (got "${forced}")`);
    }
    return forced;
  }
  const { agent: saved } = credentials;
  if (saved && hasCommand(saved)) return saved;
  return AGENT_NAMES.find(hasCommand) ?? saved ?? "claude";
};

/**
 * Config for a registered device (credentials saved by `register`): a personal worker serving
 * its owner's tickets, or a shared worker an admin added to the pool.
 */
export const loadConfig = (
  credentials: WatcherCredentials,
  hasCommand: (command: string) => boolean,
): WatcherConfig => {
  const agent = loadAgent(credentials, hasCommand);
  // A saved model names one agent's model, so it only follows that agent.
  const savedModel =
    credentials.agent === undefined || credentials.agent === agent ? credentials.model : undefined;
  const model = process.env.WATCHER_MODEL || savedModel;
  return {
    mcpUrl: `${credentials.server}/mcp`,
    workerId: credentials.workerId,
    workerType: "local",
    agent,
    ...(model && { model }),
    intervalMs: envNumber("POLL_INTERVAL_MS", 5 * 60 * 1000),
    maxSessions: envNumber("MAX_SESSIONS", 1),
    cwd: env("WORKER_CWD", process.cwd()),
    secret: credentials.secret,
    skills: !["0", "false", "off"].includes((process.env.WATCHER_SKILLS ?? "").toLowerCase()),
  };
};
