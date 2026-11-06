import {
  JEV_MODEL_ID,
  makeAgentRuntime,
  makeIntentClassifier,
  newModels,
  openLocalStorage,
} from "@project-os/agent-runtime";
import { DEFAULT_WORKER_ID, env, envBool, envNumber, healthConfig } from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { makeConnections, type OAuthClientConfig } from "@project-os/auth";
import { DEFAULT_ORG, ensureOrg, LocalLive, openLocalDb } from "@project-os/infra-local";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp } from "./app.ts";
import { startHealthSweep } from "./health/start.ts";

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
    }),
  ),
);

// Later layers win: AiLive and connections replace LocalLive's placeholders.
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({
      dbPath,
      adapterUrls: { discord: env("DISCORD_ADAPTER_URL", "http://localhost:8081") },
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
        // Admin identity (POC): only these Discord user ids may use the admin channel.
        ...(adminChannelId && { adminChannelId, adminUserIds }),
      },
      // /project-create etc.: same admin channel and user list as the admin dialogue.
      commands: {
        ...(adminChannelId && { adminChannelId, adminUserIds }),
        admin: adminActions,
        connections: (effect) => runtime.runPromise(effect),
      },
    },
    mcp: runtime,
    ...(connections && { connect: connections }),
  },
).listen(port);
console.log(`coordinator listening on :${port} (MCP at /mcp)`);
if (!connections) console.log("account linking off: set BETTER_AUTH_SECRET and an OAuth client");
