import {
  CloudflareLive,
  DEFAULT_ORG,
  discordGatewayRoute,
  DrizzleD1,
  ensureOrg,
} from "@project-os/infra-cloudflare";
import { Layer } from "effect";
import { env as workerEnv, waitUntil } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { assembleCoordinator } from "./assembly.ts";
import { piAi } from "./pi-ai.ts";
import { durableAgentRuntime, type PiAgent } from "./pi-agent.ts";

export { PiAgent } from "./pi-agent.ts";

interface Bindings {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly PI_AGENT: DurableObjectNamespace<PiAgent>;
  /** R2 bucket for files people attach; absent: attachments stay on their Discord links. */
  readonly ASSETS?: R2Bucket;
  /** Service binding to the Discord gateway Worker; absent when the gateway runs off-platform. */
  readonly DISCORD_GATEWAY?: Fetcher;
}

/**
 * Builds the Coordinator from the Worker's bindings. This must run at module load: Elysia's
 * `.compile()` uses `new Function`, which workerd allows only during startup.
 */
const buildCoordinator = (bindings: Bindings) => {
  const publicUrl = process.env.PUBLIC_URL;
  const coordinator = assembleCoordinator({
    env: process.env,
    publicUrl,
    orgId: DEFAULT_ORG.id,
    database: DrizzleD1(bindings.DB),
    platform: ({ skillSource, workerLauncher, assetSecret }) =>
      Layer.merge(
        CloudflareLive({
          db: bindings.DB,
          kv: bindings.KV,
          ...discordGatewayRoute(process.env.DISCORD_SPLIT_GATEWAY_URL, bindings.DISCORD_GATEWAY),
          ...(workerLauncher && { workerLauncher }),
          skillSource,
          ...(bindings.ASSETS &&
            publicUrl && {
              assets: { bucket: bindings.ASSETS, publicUrl, secret: assetSecret },
            }),
        }),
        Layer.effectDiscard(ensureOrg(bindings.DB)),
      ),
    // The chat model and its sessions live in the PiAgent Durable Object.
    ai: piAi(process.env, () => durableAgentRuntime(bindings.PI_AGENT)),
    waitUntil,
    server: { adapter: CloudflareAdapter },
  });
  return { app: coordinator.app.compile(), jobs: coordinator.jobs };
};

const built = buildCoordinator(workerEnv as unknown as Bindings);

export default {
  fetch: (request: Request, ...rest: unknown[]) =>
    (built.app.fetch as (...args: unknown[]) => Promise<Response>)(request, ...rest),
  // The Cron Trigger (ADR 0001): one run of each job.
  scheduled: (
    _controller: unknown,
    _env: unknown,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) => {
    for (const { name, run } of built.jobs) {
      ctx.waitUntil(run().catch((e) => console.error(`${name.replace("-", " ")} failed`, e)));
    }
  },
};
