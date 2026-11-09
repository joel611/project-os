import {
  JEV_MODEL_ID,
  makeIntentClassifier,
  newModels,
} from "@project-os/agent-runtime/classifier";
import { makeConnections, type OAuthClientConfig } from "@project-os/auth";
import { env, envBool, envNumber, healthConfig } from "@project-os/config";
import { CloudflareLive, DEFAULT_ORG, ensureOrg, serviceFetch } from "@project-os/infra-cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { env as workerEnv } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp, parseOrigins } from "./app.ts";
import { durableAgentRuntime, type PiAgent } from "./pi-agent.ts";

export { PiAgent } from "./pi-agent.ts";

// Cloudflare target: Workers + D1 + KV (docs/technical-architecture.md §8).
//
// What runs here: the HTTP API (/inbound, /commands, ...), the MCP endpoint Watchers poll,
// and account linking. The agent runtime (Pi Durable) runs in the `PiAgent` Durable Object.
// What does not yet: the health sweep (no Cron handler) and the sandbox pool. See "Known gaps" in docs/deployment.md.

interface Bindings {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly PI_AGENT: DurableObjectNamespace<PiAgent>;
  /** Service binding to the Discord gateway Worker; absent when the gateway runs off-platform. */
  readonly DISCORD_GATEWAY?: Fetcher;
}

const oauthClient = (prefix: string): OAuthClientConfig | undefined => {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

/**
 * Builds the app from the Worker's bindings. This must run at module load: Elysia's
 * `.compile()` uses `new Function`, which workerd allows only before the first request.
 * Nothing here does I/O; the layers build lazily on the first `runPromise`.
 */
const buildApp = (bindings: Bindings) => {
  const models = newModels();
  const jevModelId = env("JEV_MODEL_ID", JEV_MODEL_ID);
  const jev = models.getModelOfType("classifier", "openrouter", jevModelId);
  if (!jev) throw new Error(`Unknown classifier model ${jevModelId}`);

  const google = oauthClient("GOOGLE");
  const github = oauthClient("GITHUB");
  const authSecret = process.env.BETTER_AUTH_SECRET;
  const publicUrl = process.env.PUBLIC_URL;
  // Callbacks are built from PUBLIC_URL, so account linking stays off without it.
  const connections =
    authSecret && publicUrl && (google || github)
      ? makeConnections({
          db: drizzle(bindings.DB),
          baseURL: publicUrl,
          secret: authSecret,
          ...(google && { google }),
          ...(github && { github }),
        })
      : undefined;

  const gatewayUrl = process.env.DISCORD_SPLIT_GATEWAY_URL;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      CloudflareLive({
        db: bindings.DB,
        kv: bindings.KV,
        adapterUrls: gatewayUrl ? { discord: gatewayUrl } : {},
        ...(bindings.DISCORD_GATEWAY && { adapterFetch: serviceFetch(bindings.DISCORD_GATEWAY) }),
        agent: durableAgentRuntime(bindings.PI_AGENT),
      }),
      makeIntentClassifier({ classifier: models, model: jev }),
      // Projects reference an org (FK) and nothing else creates one.
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

  return createApp(
    { adapter: CloudflareAdapter },
    {
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
      // The dashboard is served from its own origin and calls this API directly.
      corsOrigins: parseOrigins(process.env.WEB_ORIGIN),
      ...(connections && { connect: connections }),
    },
  ).compile();
};

export default buildApp(workerEnv as unknown as Bindings);
