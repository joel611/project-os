/**
 * Wire format between the Coordinator and the Cloudflare Sandbox bridge Worker. Cloudflare
 * Sandboxes are Durable Objects reachable only from a Worker binding, so the Bun Coordinator
 * talks to a small Worker (apps/cloudflare-sandbox) that holds the binding.
 *
 *   POST   /sessions      StartSession     -> { id }
 *   GET    /sessions/:id                   -> SessionStatus
 *   DELETE /sessions/:id                   -> 204, destroys the sandbox
 *
 * Every request carries `Authorization: Bearer <CLOUDFLARE_SANDBOX_TOKEN>`.
 */
export interface StartSession {
  readonly env: Readonly<Record<string, string>>;
  readonly command: string;
}

export type SessionStatus =
  | { readonly state: "running" }
  | { readonly state: "exited"; readonly exitCode: number; readonly output: string };
