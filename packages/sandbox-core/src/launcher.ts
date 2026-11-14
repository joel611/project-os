import { SANDBOX_PROVIDER_OF } from "@project-os/contracts";
import { workerSessionStart } from "@project-os/system-prompts";
import {
  DEFAULT_SANDBOX_SESSION_SECONDS,
  LaunchFailed,
  type SandboxPoolEntry,
  type WorkerLauncher,
} from "@project-os/core";
import { Effect } from "effect";

/**
 * The provider seam: runs one shell command to completion in a throwaway sandbox, then always
 * deletes it. Daytona, Cloudflare Sandbox and (later) boat.dev each implement this.
 */
export interface SandboxRunner {
  readonly run: (input: {
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
    readonly timeoutSeconds: number;
  }) => Promise<{ readonly exitCode: number; readonly output: string }>;
}

/** One provider in the pool: what it runs as, how to start it, and how many at once. */
export interface SandboxProvider extends SandboxPoolEntry {
  readonly runner: SandboxRunner;
}

export interface SandboxLauncherConfig {
  /** The pool, in the order the Coordinator should try it. */
  readonly providers: ReadonlyArray<SandboxProvider>;
  /** Coordinator MCP URL as the sandbox sees it (public; never the host's localhost). */
  readonly mcpUrl: string;
  readonly openrouterApiKey: string;
  /** Pi model pattern, e.g. `openrouter/anthropic/claude-sonnet-4.5`. */
  readonly model: string;
  readonly timeoutSeconds?: number;
  readonly log: (message: string) => void;
}

/** Name of the Coordinator in Pi's `mcp.json`; its tools are `mcp__project-os__*`. */
export const MCP_SERVER_NAME = "project-os";

export const DEFAULT_TIMEOUT_SECONDS = DEFAULT_SANDBOX_SESSION_SECONDS;

export const piMcpJson = (mcpUrl: string, mcpToken: string): string =>
  JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${mcpToken}` },
        // `direct` declares the tools to the model; the default would hide them behind codemode.
        exposure: "direct",
      },
    },
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
  config: Pick<SandboxLauncherConfig, "mcpUrl" | "openrouterApiKey" | "model">,
  session: { readonly workerId: string; readonly mcpToken: string },
): Record<string, string> => ({
  OPENROUTER_API_KEY: config.openrouterApiKey,
  PROJECT_OS_MCP_JSON: piMcpJson(config.mcpUrl, session.mcpToken),
  PROJECT_OS_MODEL: config.model,
  PROJECT_OS_PROMPT: workerSessionStart(session.workerId),
});

/**
 * Starts a Pi session for sandbox tickets on the provider the ticket was assigned to, and
 * reports the pool to the Coordinator. `launch` returns as soon as the sandbox work is kicked
 * off. A launch that cannot even start (a worker type outside the pool, or the runner throwing
 * on kickoff) fails `LaunchFailed`, so the Coordinator queues the ticket again. A session that
 * fails after kickoff is only logged: the ticket stays `assigned` for the health sweep to flag.
 */
export const makeSandboxLauncher = (
  config: SandboxLauncherConfig,
): typeof WorkerLauncher.Service => {
  const byType = new Map<string, SandboxProvider>(
    config.providers.map((p) => [p.workerType, p] as const),
  );
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const pool: ReadonlyArray<SandboxPoolEntry> = config.providers.map(
    ({ workerType, maxConcurrent }) => ({
      workerType,
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
      sessionTimeoutSeconds: timeoutSeconds,
    }),
  );
  return {
    pool: Effect.succeed(pool),
    launch: ({ ticketId, workerType, workerId, mcpToken }) =>
      Effect.try({
        try: () => {
          const provider = byType.get(workerType);
          if (provider === undefined) throw new Error(`no ${workerType} provider in the pool`);
          const name = SANDBOX_PROVIDER_OF[provider.workerType];
          config.log(`${name}: launching ${workerId} for ticket ${ticketId}`);
          provider.runner
            .run({
              env: sessionEnv(config, { workerId, mcpToken }),
              command: SESSION_COMMAND,
              timeoutSeconds,
            })
            .then(
              ({ exitCode, output }) =>
                config.log(
                  exitCode === 0
                    ? `${name}: ${workerId} finished`
                    : `${name}: ${workerId} exited ${exitCode}: ${output.slice(-500)}`,
                ),
              (e) =>
                config.log(
                  `${name}: ${workerId} failed: ${e instanceof Error ? e.message : String(e)}`,
                ),
            );
        },
        catch: (e) => new LaunchFailed({ message: e instanceof Error ? e.message : String(e) }),
      }),
  };
};
