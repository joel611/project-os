import {
  JEV_MODEL_ID,
  makeIntentClassifier,
  newModels,
} from "@project-os/agent-runtime/classifier";
import { makeAuth } from "@project-os/auth";
import { channelDigestConfig, env, envBool, healthConfig } from "@project-os/config";
import { CloudflareLive, DEFAULT_ORG, ensureOrg, serviceFetch } from "@project-os/infra-cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { env as workerEnv, waitUntil } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { healthSweep } from "@project-os/core";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp, parseOrigins } from "./app.ts";
import { makeAccess } from "./access.ts";
import { authConfigFromEnv, serviceTokenFromEnv } from "./auth-env.ts";
import { coordinatorConfig } from "./config.ts";
import { channelDigesterFromEnv, digestAndLog } from "./digest/index.ts";
import { heldOpen } from "./held-open.ts";
import { durableAgentRuntime, type PiAgent } from "./pi-agent.ts";
import { configuredRunners, sandboxLauncherFromEnv } from "./sandbox-pool.ts";
import sessionStartPrompt from "../../watcher/prompts/session-start.md";

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
 * Builds the app from the Worker's bindings. This must run at module load: Elysia's
 * `.compile()` uses `new Function`, which workerd allows only during startup.
 */
const buildApp = (bindings: Bindings) => {
  const models = newModels();
  const jevModelId = env("JEV_MODEL_ID", JEV_MODEL_ID);
  const jev = models.getModelOfType("classifier", "openrouter", jevModelId);
  if (!jev) throw new Error(`Unknown classifier model ${jevModelId}`);

  const publicUrl = process.env.PUBLIC_URL;
  const webOrigins = parseOrigins(process.env.WEB_ORIGIN);
  const auth = makeAuth(
    authConfigFromEnv(process.env, {
      db: drizzle(bindings.DB),
      ...(publicUrl && { baseURL: publicUrl }),
      webOrigins,
    }),
  );
  const connections = auth.connections;
  const serviceToken = serviceTokenFromEnv(process.env);

  const workerLauncher = sandboxLauncherFromEnv(process.env, {
    prompt: sessionStartPrompt,
    log: console.log,
    runners: Object.fromEntries(
      Object.entries(configuredRunners(process.env)).map(([provider, runner]) => [
        provider,
        heldOpen(runner, waitUntil),
      ]),
    ),
  });

  const gatewayUrl = process.env.DISCORD_SPLIT_GATEWAY_URL;
  const digestConfig = channelDigestConfig();
  const digester = channelDigesterFromEnv(models, process.env);
  const digest = { ...digestConfig, enabled: digester !== undefined };
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      CloudflareLive({
        db: bindings.DB,
        kv: bindings.KV,
        adapterUrls: gatewayUrl ? { discord: gatewayUrl } : {},
        ...(bindings.DISCORD_GATEWAY && { adapterFetch: serviceFetch(bindings.DISCORD_GATEWAY) }),
        agent: durableAgentRuntime(bindings.PI_AGENT),
        ...(workerLauncher && { workerLauncher }),
        ...(bindings.ASSETS &&
          publicUrl && {
            assets: {
              bucket: bindings.ASSETS,
              publicUrl,
              secret: process.env.BETTER_AUTH_SECRET!,
            },
          }),
      }),
      makeIntentClassifier({ classifier: models, model: jev }),
      ...(digester ? [digester] : []),
      Layer.effectDiscard(ensureOrg(bindings.DB)),
      ...(connections ? [connections.layer] : []),
    ),
  );

  const runAdmin = <A>(effect: Effect.Effect<A, unknown, AdminEnv>): Promise<A> =>
    runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>);
  const adminActions = makeAdminActions({
    run: runAdmin,
    orgId: DEFAULT_ORG.id,
    autoCreateChannel: envBool("DISCORD_PROJECT_CHANNEL_AUTO_CREATE", true),
  });

  const app = createApp(
    { adapter: CloudflareAdapter },
    {
      ...coordinatorConfig({
        env: process.env,
        run: (effect) => runtime.runPromise(effect),
        publicUrl: () => publicUrl ?? "",
        admin: adminActions,
        inbound: { channelDigest: digest.enabled },
      }),
      access: makeAccess({ serviceToken, auth }),
      mcp: runtime,
      auth,
      ...(connections && { connect: connections }),
    },
  ).compile();

  const sweep = () => runtime.runPromise(healthSweep(healthConfig()));
  // Same Cron tick as the sweep (ADR 0001); a project is digested only once its chat is quiet.
  const digestRun = () =>
    digest.enabled ? runtime.runPromise(digestAndLog(digest)) : Promise.resolve();
  return { app, sweep, digest: digestRun };
};

const built = buildApp(workerEnv as unknown as Bindings);

export default {
  fetch: (request: Request, ...rest: unknown[]) =>
    (built.app.fetch as (...args: unknown[]) => Promise<Response>)(request, ...rest),
  scheduled: (
    _controller: unknown,
    _env: unknown,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) => {
    ctx.waitUntil(built.sweep().catch((e) => console.error("health sweep failed", e)));
    ctx.waitUntil(built.digest().catch((e) => console.error("channel digest failed", e)));
  },
};
