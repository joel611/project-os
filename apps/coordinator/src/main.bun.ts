import {
  JEV_MODEL_ID,
  makeAgentRuntime,
  makeIntentClassifier,
  newModels,
  openLocalStorage,
} from "@project-os/agent-runtime";
import { env, envBool, envNumber, healthConfig } from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { makeAuth } from "@project-os/auth";
import { DEFAULT_ORG, ensureOrg, LocalLive, openLocalDb } from "@project-os/infra-local";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createDiscord } from "@project-os/channel-discord";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp, parseOrigins } from "./app.ts";
import { assetBaseUrl } from "./assets/base-url.ts";
import { makeAccess } from "./access.ts";
import { authConfigFromEnv, serviceTokenFromEnv } from "./auth-env.ts";
import { startHealthSweep } from "./health/start.ts";
import { sandboxLauncherFromEnv } from "./sandbox-pool.ts";
import { setupTelemetry } from "./telemetry.ts";

// Local target: Bun + infra-local + Pi/Jev agent runtime (docs/technical-architecture.md §8).
const port = envNumber("PORT", 8080);
const dbPath = dataPath("project-os.sqlite", process.env.DATABASE_PATH ?? process.env.DB_PATH);

// Projects reference an org (FK), and nothing else creates one.
const orgId = ensureOrg(dbPath, DEFAULT_ORG);

const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`);
const webOrigins = parseOrigins(process.env.WEB_ORIGIN);

// Better Auth: dashboard sign-in, and account linking (people link Google / GitHub with /connect,
// and Workers use that person's own token) when an OAuth client is set.
const auth = makeAuth(
  authConfigFromEnv(process.env, { db: openLocalDb(dbPath).db, baseURL: publicUrl, webOrigins }),
);
await auth.ready();
const connections = auth.connections;
const serviceToken = serviceTokenFromEnv(process.env);

const models = newModels();
const jevModelId = env("JEV_MODEL_ID", JEV_MODEL_ID);
const jev = models.getModelOfType("classifier", "openrouter", jevModelId);
if (!jev) throw new Error(`Unknown classifier model ${jevModelId}`);

// Explicit return type: `runtime` is defined below and depends on this function.
const runAdmin = <A>(effect: Effect.Effect<A, unknown, AdminEnv>): Promise<A> =>
  runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>);

// Shared by the admin dialogue's tools and the admin slash commands (POST /commands).
const adminActions = makeAdminActions({
  run: runAdmin,
  orgId,
  // Admin create_project also creates the project's Discord channel (needs Manage Channels).
  autoCreateChannel: envBool("DISCORD_PROJECT_CHANNEL_AUTO_CREATE", true),
});

const otel = setupTelemetry(process.env);

// Failing to open the Pi harness at startup is fatal, so build errors become defects.
const AiLive = Layer.orDie(
  Layer.mergeAll(
    makeIntentClassifier({ classifier: models, model: jev }),
    makeAgentRuntime({
      storage: await openLocalStorage(dataPath("pi-durable.sqlite", process.env.PI_STORAGE_PATH)),
      models,
      model: { provider: env("CHAT_MODEL_PROVIDER", "openrouter"), modelId: env("CHAT_MODEL_ID") },
      // `runtime` is assigned below; the actions only run once a message arrives.
      adminActions,
      // Pi Durable spans/metrics over OTLP; undefined (no-op) unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
      telemetry: otel?.telemetry,
    }),
  ),
);

// The sandbox pool: Daytona, Cloudflare Sandbox and/or boat.dev, in WORKER_PROVIDERS order. Each
// joins only when its credentials are set. Shared devices that admins register come first; with
// neither free, new tickets wait queued until the health sweep finds room.
const workerLauncher = sandboxLauncherFromEnv(process.env, {
  prompt: await Bun.file(new URL("../../watcher/prompts/session-start.md", import.meta.url)).text(),
  log: console.log,
});

// Discord runs inside this process when a bot token is set. Its reply endpoint binds loopback on
// a free port: it can post as the bot, so it must not sit on the public port. DISCORD_SPLIT_GATEWAY_URL
// points at a separate apps/discord-gateway instead (Cloudflare, or the fake in TESTING.md) and wins.
const remoteGatewayUrl = process.env.DISCORD_SPLIT_GATEWAY_URL;
const discordToken = process.env.DISCORD_BOT_TOKEN;
const discord =
  discordToken && !remoteGatewayUrl
    ? createDiscord({
        token: discordToken,
        coordinator: { url: `http://localhost:${port}`, token: serviceToken },
        replyPort: 0,
        replyHost: "127.0.0.1",
      })
    : undefined;
if (discordToken && remoteGatewayUrl) {
  console.log(
    `DISCORD_BOT_TOKEN ignored: DISCORD_SPLIT_GATEWAY_URL is set, replies go to ${remoteGatewayUrl}`,
  );
} else if (!discordToken && !remoteGatewayUrl) {
  // Env is read once at startup, so adding the token needs a restart.
  console.log("Discord off: set DISCORD_BOT_TOKEN and restart the Coordinator to enable it");
}

// Later layers win: AiLive and connections replace LocalLive's placeholders.
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({
      dbPath,
      adapterUrls: { discord: discord?.replyUrl ?? remoteGatewayUrl ?? "http://localhost:8081" },
      ...(workerLauncher && { workerLauncher }),
      // Files people attach are copied here at intake and served as signed links. Sandbox
      // workers are in the cloud, so links use their reachable URL when one is set.
      assets: {
        dir: dataPath("assets", process.env.ASSET_DIR),
        publicUrl: assetBaseUrl(process.env, publicUrl),
        secret: process.env.BETTER_AUTH_SECRET!,
      },
    }),
    AiLive,
    ...(connections ? [connections.layer] : []),
  ),
);

// The stop effect is intentionally dropped: the sweep lives as long as the process.
await runtime.runPromise(startHealthSweep(healthConfig()).pipe(Effect.asVoid));

const adminChannelId = process.env.ADMIN_CHANNEL_ID;
const adminUserIds = (process.env.ADMIN_USER_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

createApp(
  {},
  {
    access: makeAccess({ serviceToken, auth }),
    http: {
      run: (effect) => runtime.runPromise(effect),
      inbound: {
        confidenceThreshold: envNumber("INTENT_CONFIDENCE_THRESHOLD", 0.5),
        // Top-level project channel messages must @mention the bot; threads and admin don't.
        requireMention: envBool("DISCORD_REQUIRE_MENTION", true),
        // Registered devices count as online within the health sweep's window.
        workerStaleMs: healthConfig().workerStaleMs,
        sharedWorkerMaxTickets: healthConfig().sharedWorkerMaxTickets,
        // Admin identity (POC): only these Discord user ids may use the admin channel.
        ...(adminChannelId && { adminChannelId, adminUserIds }),
      },
      // /project-create etc.: same admin channel and user list as the admin dialogue.
      commands: {
        ...(adminChannelId && { adminChannelId, adminUserIds }),
        admin: adminActions,
        connections: (effect) => runtime.runPromise(effect),
        // /register-worker: the Watcher on a person's computer registers and polls at PUBLIC_URL.
        workers: {
          run: (effect) => runtime.runPromise(effect),
          publicUrl,
          ...(process.env.WATCHER_INSTALL_COMMAND && {
            installCommand: process.env.WATCHER_INSTALL_COMMAND,
          }),
          staleMs: healthConfig().workerStaleMs,
        },
      },
    },
    mcp: runtime,
    assets: { run: (effect) => runtime.runPromise(effect) },
    // Only needed when the dashboard is served from another origin; locally Vite proxies /api.
    corsOrigins: webOrigins,
    auth,
    ...(connections && { connect: connections }),
  },
).listen(port);
// After listen: the first message POSTs to /inbound on this very server. A failed login (bad
// token, missing intent) leaves the Coordinator, MCP and Watchers up; only Discord is down.
discord?.login().catch((err) => {
  console.error("Discord login failed; the Coordinator keeps running without Discord", err);
});
// Flush buffered spans/metrics on `docker compose stop` / Ctrl-C.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (otel?.shutdown() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
console.log(`coordinator listening on :${port} (MCP at /mcp)`);
if (!connections) console.log("account linking off: set an OAuth client (GOOGLE_* / GITHUB_*)");
