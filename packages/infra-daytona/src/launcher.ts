import type { WorkerLauncher } from "@project-os/core";
import { Effect } from "effect";

/** Runs one shell command to completion in a throwaway sandbox, then always deletes it. */
export interface SandboxRunner {
  readonly run: (input: {
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
    readonly timeoutSeconds: number;
  }) => Promise<{ readonly exitCode: number; readonly output: string }>;
}

export interface DaytonaLauncherConfig {
  readonly sandbox: SandboxRunner;
  /** Coordinator MCP URL as the sandbox sees it (public; never the host's localhost). */
  readonly mcpUrl: string;
  readonly openrouterApiKey: string;
  /** Pi model pattern, e.g. `openrouter/anthropic/claude-sonnet-4.5`. */
  readonly model: string;
  /** The session-start instruction; the worker id is appended per ticket. */
  readonly prompt: string;
  readonly timeoutSeconds?: number;
  readonly log: (message: string) => void;
}

/** Name of the Coordinator in Pi's `mcp.json`; its tools are `mcp__project-os__*`. */
export const MCP_SERVER_NAME = "project-os";

export const DEFAULT_TIMEOUT_SECONDS = 30 * 60;

export const piMcpJson = (mcpUrl: string): string =>
  JSON.stringify({
    // `direct` declares the tools to the model; the default would hide them behind codemode.
    mcpServers: { [MCP_SERVER_NAME]: { url: mcpUrl, exposure: "direct" } },
  });

// Values arrive as env vars so no ticket-derived text is ever interpolated into the shell line.
export const SESSION_COMMAND = [
  "set -e",
  "npm install -g @earendil-works/pi-coding-agent",
  "mkdir -p ~/.pi/agent",
  'printf "%s" "$PROJECT_OS_MCP_JSON" > ~/.pi/agent/mcp.json',
  'pi --print --model "$PROJECT_OS_MODEL" "$PROJECT_OS_PROMPT"',
].join(" && ");

export const sessionEnv = (
  config: DaytonaLauncherConfig,
  workerId: string,
): Record<string, string> => ({
  OPENROUTER_API_KEY: config.openrouterApiKey,
  PROJECT_OS_MCP_JSON: piMcpJson(config.mcpUrl),
  PROJECT_OS_MODEL: config.model,
  PROJECT_OS_PROMPT: `${config.prompt}\nYour worker_id is \`${workerId}\`.`,
});

/**
 * Starts a Pi session in a fresh Daytona sandbox for `daytona_pi` tickets. `launch` returns as
 * soon as the sandbox work is kicked off; failures are logged, and the ticket stays `assigned`
 * for the health sweep to flag.
 */
export const makeDaytonaLauncher = (
  config: DaytonaLauncherConfig,
): typeof WorkerLauncher.Service => ({
  launch: ({ ticketId, workerType, workerId }) =>
    Effect.sync(() => {
      if (workerType !== "daytona_pi") return;
      config.log(`daytona: launching ${workerId} for ticket ${ticketId}`);
      config.sandbox
        .run({
          env: sessionEnv(config, workerId),
          command: SESSION_COMMAND,
          timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        })
        .then(
          ({ exitCode, output }) =>
            config.log(
              exitCode === 0
                ? `daytona: ${workerId} finished`
                : `daytona: ${workerId} exited ${exitCode}: ${output.slice(-500)}`,
            ),
          (e) =>
            config.log(
              `daytona: ${workerId} failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        );
    }),
});
