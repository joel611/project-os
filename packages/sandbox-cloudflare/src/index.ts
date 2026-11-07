import { cloudflareSandboxRunner } from "./client.ts";

export {
  cloudflareSandboxRunner,
  DEFAULT_POLL_MS,
  type CloudflareSandboxClientOptions,
} from "./client.ts";
export type { SessionStatus, StartSession } from "./protocol.ts";

/** Cloudflare Sandbox's runner with real timers, for the Coordinator's composition root. */
export const cloudflareSandboxRunnerLive = (options: {
  readonly url: string;
  readonly token: string;
  readonly pollMs?: number;
}) =>
  cloudflareSandboxRunner({
    ...options,
    // Looked up per call, so a test stack's fetch guard still applies.
    fetch: ((input, init) => fetch(input, init)) as typeof fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
