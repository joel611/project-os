import { Container, getContainer } from "@cloudflare/containers";
import { CONTAINER_ENV, containerEnv, envFingerprint, REPLY_PORT } from "./container-env.ts";

/** Storage key for the hash of the env the running container started with. */
const ENV_KEY = "container-env";

// Cloudflare target for the Discord gateway (docs/deployment.md). The gateway is a long-lived
// Bun process holding Discord's outbound WebSocket, so it runs in a Cloudflare Container behind
// this Worker. The Worker has no public URL: the Coordinator reaches it through a service
// binding, because the reply endpoint can post as the bot and has no authentication.

type GatewayEnv = { readonly [K in (typeof CONTAINER_ENV)[number]]?: string } & {
  readonly Gateway: DurableObjectNamespace<DiscordGateway>;
};

export class DiscordGateway extends Container<GatewayEnv> {
  override defaultPort = REPLY_PORT;
  // The Discord socket is not "activity" to Cloudflare, so a sleep timer would stop a healthy
  // bot. onActivityExpired renews it: the container runs until it exits or is redeployed.
  override sleepAfter = "24h";
  override enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: GatewayEnv) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }

  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout();
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.error(`discord gateway container stopped: ${params.reason} (${params.exitCode})`);
  }

  /**
   * Starts the container if it is not running, and waits for the reply endpoint. A running
   * container whose env differs from this Worker's (a redeploy changed COORDINATOR_URL or a
   * token, or it predates this check) is stopped first, since it only reads env at start.
   */
  async ensureStarted(): Promise<void> {
    const wanted = await envFingerprint(this.envVars as Record<string, string>);
    if (this.ctx.container?.running) {
      if ((await this.ctx.storage.get<string>(ENV_KEY)) === wanted) return;
      await this.stop();
    }
    await this.startAndWaitForPorts(REPLY_PORT);
    await this.ctx.storage.put(ENV_KEY, wanted);
  }
}

const instance = (env: GatewayEnv) => getContainer(env.Gateway, "discord");

export default {
  fetch: (request: Request, env: GatewayEnv): Promise<Response> => instance(env).fetch(request),
  // Cron Trigger: brings the container back after a crash, a stop or a deploy.
  scheduled: async (_controller: unknown, env: GatewayEnv): Promise<void> => {
    await instance(env).ensureStarted();
  },
};
