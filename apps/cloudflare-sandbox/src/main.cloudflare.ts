// Cloudflare Sandbox bridge Worker. Sandboxes are Durable Objects reachable only through a
// Worker binding, so the Coordinator (on Bun) starts and polls them over this small HTTP API.
// Routes and wire format: packages/infra-cloudflare-sandbox/src/protocol.ts.
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { handleBridge } from "@project-os/infra-cloudflare-sandbox/bridge";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  readonly Sandbox: DurableObjectNamespace<Sandbox>;
  /** Shared secret; the Coordinator's CLOUDFLARE_SANDBOX_TOKEN. */
  readonly BRIDGE_TOKEN?: string;
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    handleBridge(request, {
      token: env.BRIDGE_TOKEN ?? "",
      // Sleeps after 10 idle minutes: a net if the Coordinator never sends DELETE.
      sandbox: (id) => getSandbox(env.Sandbox, id, { sleepAfter: "10m" }),
      newId: () => crypto.randomUUID(),
    }),
};
