import type { SandboxRunner } from "@project-os/sandbox-core";
import type { SessionStatus, StartSession } from "./protocol.ts";

export const DEFAULT_POLL_MS = 5_000;

export interface CloudflareSandboxClientOptions {
  /** Base URL of the bridge Worker, e.g. `https://project-os-sandbox.<you>.workers.dev`. */
  readonly url: string;
  /** Shared secret the bridge checks (its `BRIDGE_TOKEN`). */
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Between status checks. Default 5 s. */
  readonly pollMs?: number;
}

/**
 * Cloudflare Sandbox's `SandboxRunner`: starts the session through the bridge Worker, polls
 * until it exits or times out, then always destroys the sandbox. Polling also keeps the
 * sandbox awake; if the Coordinator goes away, it sleeps and is reclaimed on its own.
 */
export const cloudflareSandboxRunner = (options: CloudflareSandboxClientOptions): SandboxRunner => {
  const base = options.url.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await options.fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`cloudflare sandbox ${method} ${path}: ${res.status} ${text}`.trim());
    }
    return res;
  };
  return {
    run: async ({ env, command, timeoutSeconds }) => {
      const start: StartSession = { env, command };
      const { id } = (await (await call("POST", "/sessions", start)).json()) as { id: string };
      const path = `/sessions/${encodeURIComponent(id)}`;
      try {
        const deadline = options.now() + timeoutSeconds * 1000;
        for (;;) {
          const status = (await (await call("GET", path)).json()) as SessionStatus;
          if (status.state === "exited")
            return { exitCode: status.exitCode, output: status.output };
          if (options.now() > deadline) throw new Error(`session exceeded ${timeoutSeconds}s`);
          await options.sleep(options.pollMs ?? DEFAULT_POLL_MS);
        }
      } finally {
        await call("DELETE", path).catch(() => undefined);
      }
    },
  };
};
