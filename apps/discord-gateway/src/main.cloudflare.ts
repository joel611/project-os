import { DurableObject } from "cloudflare:workers";
import { CONTAINER_ENV, containerEnv, envFingerprint, REPLY_PORT } from "./container-env.ts";

/** Storage key for the hash of the env the running container started with. */
const ENV_KEY = "container-env";

/** The Container's id in alchemy.run.ts: its image sits under this key in `ctx.container.images`. */
const IMAGE = "GatewayImage";
const READY_TIMEOUT_MS = 30_000;

// Cloudflare target for the Discord gateway (docs/deployment.md). The gateway is a long-lived
// Bun process holding Discord's outbound WebSocket, so it runs in a Cloudflare Container behind
// this Worker. The Worker has no public URL: the Coordinator reaches it through a service
// binding, because the reply endpoint can post as the bot and has no authentication.

type GatewayEnv = { readonly [K in (typeof CONTAINER_ENV)[number]]?: string } & {
  readonly Gateway: DurableObjectNamespace<GatewayContainer>;
};

/**
 * A Durable Object that owns the container directly (`ctx.container`), not through the
 * `@cloudflare/containers` wrapper. Cloudflare rejects a standalone container application on
 * accounts that require a Durable Object attached at creation, so the stack declares the image
 * as a Durable Object-managed Container and this class starts it.
 */
export class GatewayContainer extends DurableObject<GatewayEnv> {
  #starting: Promise<void> | undefined;

  /**
   * Starts the container if it is not running, and waits for the reply endpoint. A running
   * container whose env differs from this Worker's (a redeploy changed COORDINATOR_URL or a
   * token, or it predates this check) is stopped first, since it only reads env at start.
   * The Discord socket is not activity to Cloudflare, so the container runs until it exits or
   * is redeployed; the Cron Trigger brings it back after that.
   */
  ensureStarted(): Promise<void> {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("the Gateway Durable Object has no container attached");
    const env = containerEnv(this.env);
    const wanted = await envFingerprint(env);
    if (container.running) {
      if ((await this.ctx.storage.get<string>(ENV_KEY)) === wanted) return;
      await container.destroy();
    }
    const image = container.images[IMAGE];
    if (!image) throw new Error(`no container image "${IMAGE}" on the Gateway Durable Object`);
    container.start({ image, env, instance: "lite", enableInternet: true });
    this.ctx.waitUntil(
      container.monitor().then(
        () => console.error("discord gateway container stopped"),
        (error) => console.error("discord gateway container stopped:", error),
      ),
    );
    await this.#waitForReplyPort(container);
    await this.ctx.storage.put(ENV_KEY, wanted);
  }

  async #waitForReplyPort(container: Container): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        // Any answer, even a 404, means the port is open.
        await container.getTcpPort(REPLY_PORT).fetch("http://container/");
        return;
      } catch (cause) {
        if (Date.now() > deadline) {
          throw new Error(`the gateway container did not open port ${REPLY_PORT}`, { cause });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureStarted();
    return this.ctx.container!.getTcpPort(REPLY_PORT).fetch(request);
  }
}

const instance = (env: GatewayEnv) => env.Gateway.getByName("discord");

export default {
  fetch: (request: Request, env: GatewayEnv): Promise<Response> => instance(env).fetch(request),
  // Cron Trigger: brings the container back after a crash, a stop or a deploy.
  scheduled: async (_controller: unknown, env: GatewayEnv): Promise<void> => {
    await instance(env).ensureStarted();
  },
};
