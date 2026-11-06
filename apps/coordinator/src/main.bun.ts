import {
  JEV_MODEL_ID,
  makeAgentRuntime,
  makeIntentClassifier,
  newModels,
  openLocalStorage,
} from "@project-os/agent-runtime";
import { DEFAULT_WORKER_ID, env, envBool, envNumber, healthConfig } from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { daytonaSandboxRunner, makeDaytonaLauncher } from "@project-os/infra-daytona";
import { makeConnections, type OAuthClientConfig } from "@project-os/auth";
import { DEFAULT_ORG, ensureOrg, LocalLive, openLocalDb } from "@project-os/infra-local";
import type { WorkerType } from "@project-os/contracts";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { createDiscord } from "@project-os/channel-discord";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp } from "./app.ts";
import { startHealthSweep } from "./health/start.ts";
import { setupTelemetry } from "./telemetry.ts";

// Local target: Bun + infra-local + Pi/Jev agent runtime (docs/technical-architecture.md §8).
const port = envNumber("PORT", 8080);
const dbPath = dataPath("project-os.sqlite", process.env.DATABASE_PATH ?? process.env.DB_PATH);

// Projects reference an org (FK), and nothing else creates one.
const orgId = ensureOrg(dbPath, DEFAULT_ORG);

// Account linking (Better Auth): people link Google / GitHub with /connect, and Workers use
// that person's own token. Off unless a secret and at least one OAuth client are set.
const oauthClient = (prefix: string): OAuthClientConfig | undefined => {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};
const google = oauthClient("GOOGLE");
const github = oauthClient("GITHUB");
const authSecret = process.env.BETTER_AUTH_SECRET;
const connections =
  authSecret && (google || github)
    ? makeConnections({
        db: openLocalDb(dbPath).db,
        baseURL: env("PUBLIC_URL", `http://localhost:${port}`),
        secret: authSecret,
        ...(google && { google }),
        ...(github && { github }),
      })
    : undefined;

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

// `daytona_pi` tickets start a sandbox only when a key is set; otherwise nothing launches them.
const daytonaApiKey = process.env.DAYTONA_API_KEY;
const workerLauncher = daytonaApiKey
  ? makeDaytonaLauncher({
      sandbox: daytonaSandboxRunner({
        apiKey: daytonaApiKey,
        ...(process.env.DAYTONA_API_URL && { apiUrl: process.env.DAYTONA_API_URL }),
        ...(process.env.DAYTONA_SNAPSHOT && { snapshot: process.env.DAYTONA_SNAPSHOT }),
      }),
      // The sandbox is in the cloud: this must be a public URL (tunnel), not MCP_URL.
      mcpUrl: env("DAYTONA_MCP_URL"),
      openrouterApiKey: env("OPENROUTER_API_KEY"),
      model: env("DAYTONA_PI_MODEL", `openrouter/${env("CHAT_MODEL_ID")}`),
      prompt: await Bun.file(
        new URL("../../watcher/prompts/session-start.md", import.meta.url),
      ).text(),
      timeoutSeconds: envNumber("DAYTONA_SESSION_TIMEOUT_SECONDS", 30 * 60),
      log: console.log,
    })
  : undefined;

// Discord runs inside this process when a bot token is set. Its reply endpoint binds loopback on
// a free port: it can post as the bot, so it must not sit on the public port. DISCORD_SPLIT_ADAPTER_URL
// points at a separate adapter instead (Cloudflare, or the fake in TESTING.md) and wins.
const remoteAdapterUrl = process.env.DISCORD_SPLIT_ADAPTER_URL;
const discordToken = process.env.DISCORD_BOT_TOKEN;
const discord =
  discordToken && !remoteAdapterUrl
    ? createDiscord({
        token: discordToken,
        coordinatorUrl: `http://localhost:${port}`,
        replyPort: 0,
        replyHost: "127.0.0.1",
      })
    : undefined;
if (discordToken && remoteAdapterUrl) {
  console.log(
    `DISCORD_BOT_TOKEN ignored: DISCORD_SPLIT_ADAPTER_URL is set, replies go to ${remoteAdapterUrl}`,
  );
} else if (!discordToken && !remoteAdapterUrl) {
  // Env is read once at startup, so adding the token needs a restart.
  console.log("Discord off: set DISCORD_BOT_TOKEN and restart the Coordinator to enable it");
}

// Later layers win: AiLive and connections replace LocalLive's placeholders.
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({
      dbPath,
      adapterUrls: { discord: discord?.replyUrl ?? remoteAdapterUrl ?? "http://localhost:8081" },
      ...(workerLauncher && { workerLauncher }),
    }),
    AiLive,
    ...(connections ? [connections.layer] : []),
  ),
);

await runtime.runPromise(startHealthSweep(healthConfig()));

const adminChannelId = process.env.ADMIN_CHANNEL_ID;
const adminUserIds = (process.env.ADMIN_USER_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

createApp(
  {},
  {
    http: {
      run: (effect) => runtime.runPromise(effect),
      inbound: {
        workerId: env("WORKER_ID", DEFAULT_WORKER_ID),
        confidenceThreshold: envNumber("INTENT_CONFIDENCE_THRESHOLD", 0.5),
        // Top-level project channel messages must @mention the bot; threads and admin don't.
        requireMention: envBool("DISCORD_REQUIRE_MENTION", true),
        // Personal workers count as online within the health sweep's window.
        workerStaleMs: healthConfig().workerStaleMs,
        // Tickets from someone without an online personal worker go to the shared worker:
        // Daytona when it's configured, else the shared Watcher (WORKER_ID).
        defaultWorkerType: (process.env.DEFAULT_WORKER_TYPE ??
          (daytonaApiKey ? "daytona_pi" : "local_claude")) as WorkerType,
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
          publicUrl: env("PUBLIC_URL", `http://localhost:${port}`),
          ...(process.env.WATCHER_INSTALL_COMMAND && {
            installCommand: process.env.WATCHER_INSTALL_COMMAND,
          }),
          staleMs: healthConfig().workerStaleMs,
        },
      },
    },
    mcp: runtime,
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
if (!connections) console.log("account linking off: set BETTER_AUTH_SECRET and an OAuth client");
