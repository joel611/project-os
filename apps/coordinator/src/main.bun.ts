import {
  JEV_MODEL_ID,
  makeAgentRuntime,
  makeIntentClassifier,
  newModels,
  openLocalStorage,
} from "@project-os/agent-runtime";
import { DEFAULT_WORKER_ID, env, envNumber, healthConfig } from "@project-os/config";
import { DEFAULT_ORG, ensureOrg, LocalLive } from "@project-os/infra-local";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp } from "./app.ts";
import { startHealthSweep } from "./health/start.ts";

// Local target: Bun + infra-local + Pi/Jev agent runtime (docs/technical-architecture.md §8).
const port = envNumber("PORT", 8080);
const dbPath = process.env.DATABASE_PATH ?? env("DB_PATH", "./project-os.sqlite");

// Projects reference an org (FK), and nothing else creates one.
const orgId = ensureOrg(dbPath, DEFAULT_ORG);

const models = newModels();
const jevModelId = env("JEV_MODEL_ID", JEV_MODEL_ID);
const jev = models.getModelOfType("classifier", "openrouter", jevModelId);
if (!jev) throw new Error(`Unknown classifier model ${jevModelId}`);

// Explicit return type: `runtime` is defined below and depends on this function.
const runAdmin = <A>(effect: Effect.Effect<A, unknown, AdminEnv>): Promise<A> =>
  runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>);

// Failing to open the Pi harness at startup is fatal, so build errors become defects.
const AiLive = Layer.orDie(
  Layer.mergeAll(
    makeIntentClassifier({ classifier: models, model: jev }),
    makeAgentRuntime({
      storage: await openLocalStorage(env("PI_STORAGE_PATH", "./pi-durable.sqlite")),
      models,
      model: { provider: env("CHAT_MODEL_PROVIDER", "openrouter"), modelId: env("CHAT_MODEL_ID") },
      // `runtime` is assigned below; the actions only run once a message arrives.
      adminActions: makeAdminActions({ run: runAdmin, orgId }),
    }),
  ),
);

// AiLive goes last so it replaces LocalLive's AgentRuntime placeholder.
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({
      dbPath,
      adapterUrls: { discord: env("DISCORD_ADAPTER_URL", "http://localhost:8081") },
    }),
    AiLive,
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
    },
    mcp: runtime,
  },
).listen(port);
console.log(`coordinator listening on :${port} (MCP at /mcp)`);
