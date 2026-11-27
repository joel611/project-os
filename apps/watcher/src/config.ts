import { envNumber } from "@project-os/config";
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
  /** Bearer secret this device got at registration; every MCP call sends it. */
  readonly secret: string;
  /** Install the ticket's task type before a session starts (`WATCHER_SKILLS=0` turns it off). */
  readonly skills: boolean;
  /** Send each session's transcript to the Coordinator (`WATCHER_RUN_LOG=0` or `--no-run-log` turns it off). */
  readonly runLog: boolean;
  /**
   * Run Pi through ACP (`WATCHER_PI_ACP=1`): the Watcher starts `piAcpCommand` and drives the
   * session over the protocol, which gives Pi a structured run log. Only affects `agent: "pi"`.
   */
  readonly piAcp: boolean;
  /** Program that speaks ACP for Pi (`WATCHER_PI_ACP_COMMAND`, a space-separated command line). */
  readonly piAcpCommand: readonly string[];
  /** How long a git clone or fetch may run before it is killed (`WATCHER_GIT_TIMEOUT_MS`). */
  readonly gitTimeoutMs: number;
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
    secret: credentials.secret,
    skills: !["0", "false", "off"].includes((process.env.WATCHER_SKILLS ?? "").toLowerCase()),
    runLog: !["0", "false", "off"].includes((process.env.WATCHER_RUN_LOG ?? "").toLowerCase()),
    piAcp: ["1", "true", "on"].includes((process.env.WATCHER_PI_ACP ?? "").toLowerCase()),
    piAcpCommand: (process.env.WATCHER_PI_ACP_COMMAND || "pi-acp").split(/\s+/).filter(Boolean),
    gitTimeoutMs: envNumber("WATCHER_GIT_TIMEOUT_MS", 10 * 60 * 1000),
  };
};
