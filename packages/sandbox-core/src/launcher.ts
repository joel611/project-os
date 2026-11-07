import { SANDBOX_PROVIDER_OF } from "@project-os/contracts";
import type { SandboxPoolEntry, WorkerLauncher } from "@project-os/core";
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
  config: Pick<SandboxLauncherConfig, "mcpUrl" | "openrouterApiKey" | "model" | "prompt">,
  workerId: string,
): Record<string, string> => ({
  OPENROUTER_API_KEY: config.openrouterApiKey,
  PROJECT_OS_MCP_JSON: piMcpJson(config.mcpUrl),
  PROJECT_OS_MODEL: config.model,
  PROJECT_OS_PROMPT: `${config.prompt}\nYour worker_id is \`${workerId}\`.`,
});

/**
 * Starts a Pi session for sandbox tickets on the provider the ticket was assigned to, and
 * reports the pool to the Coordinator. `launch` returns as soon as the sandbox work is kicked
 * off; failures are logged, and the ticket stays `assigned` for the health sweep to flag.
 */
export const makeSandboxLauncher = (
  config: SandboxLauncherConfig,
): typeof WorkerLauncher.Service => {
  const byType = new Map<string, SandboxProvider>(
    config.providers.map((p) => [p.workerType, p] as const),
  );
  const pool: ReadonlyArray<SandboxPoolEntry> = config.providers.map(
    ({ workerType, maxConcurrent }) => ({
      workerType,
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    }),
  );
  return {
    pool: Effect.succeed(pool),
    launch: ({ ticketId, workerType, workerId }) =>
      Effect.sync(() => {
        const provider = byType.get(workerType);
        if (provider === undefined) return;
        const name = SANDBOX_PROVIDER_OF[provider.workerType];
        config.log(`${name}: launching ${workerId} for ticket ${ticketId}`);
        provider.runner
          .run({
            env: sessionEnv(config, workerId),
            command: SESSION_COMMAND,
            timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
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
      }),
  };
};
