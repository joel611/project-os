import {
  JEV_MODEL_ID,
  makeIntentClassifier,
  newModels,
} from "@project-os/agent-runtime/classifier";
import { makeAuth } from "@project-os/auth";
import { env, envBool, envNumber, healthConfig } from "@project-os/config";
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

  const adminChannelId = process.env.ADMIN_CHANNEL_ID;
  const adminUserIds = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const app = createApp(
    { adapter: CloudflareAdapter },
    {
      access: makeAccess({ serviceToken, auth }),
      http: {
        run: (effect) => runtime.runPromise(effect),
        inbound: {
          confidenceThreshold: envNumber("INTENT_CONFIDENCE_THRESHOLD", 0.5),
          requireMention: envBool("DISCORD_REQUIRE_MENTION", true),
          workerStaleMs: healthConfig().workerStaleMs,
          sharedWorkerMaxTickets: healthConfig().sharedWorkerMaxTickets,
          ...(adminChannelId && { adminChannelId, adminUserIds }),
        },
        commands: {
          ...(adminChannelId && { adminChannelId, adminUserIds }),
          admin: adminActions,
          connections: (effect) => runtime.runPromise(effect),
          workers: {
            run: (effect) => runtime.runPromise(effect),
            publicUrl: publicUrl ?? "",
            ...(process.env.WATCHER_INSTALL_COMMAND && {
              installCommand: process.env.WATCHER_INSTALL_COMMAND,
            }),
            staleMs: healthConfig().workerStaleMs,
          },
        },
      },
      mcp: runtime,
      assets: { run: (effect) => runtime.runPromise(effect) },
      corsOrigins: webOrigins,
      auth,
      ...(connections && { connect: connections }),
    },
  ).compile();

  const sweep = () => runtime.runPromise(healthSweep(healthConfig()));
  return { app, sweep };
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
  },
};
