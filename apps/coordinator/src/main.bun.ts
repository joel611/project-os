import { env, envNumber } from "@project-os/config";
import { IntentClassifier } from "@project-os/core";
import { LocalLive } from "@project-os/infra-local";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createApp } from "./app.ts";

// Local target: Bun + infra-local. The setInterval sweep lands in #15.
const port = envNumber("PORT", 8080);

// Placeholder until the agent-runtime ticket (#14) supplies a real classifier:
// every message is a new request.
const IntentClassifierPlaceholder = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({
      dbPath: env("DB_PATH", "./project-os.sqlite"),
      adapterUrls: { discord: env("DISCORD_ADAPTER_URL", "http://localhost:8081") },
    }),
    IntentClassifierPlaceholder,
  ),
);

createApp(
  {},
  {
    http: {
      run: (effect) => runtime.runPromise(effect),
      inbound: {
        workerId: env("WORKER_ID", "local-claude-1"),
        ...(process.env.ADMIN_CHANNEL_ID && { adminChannelId: process.env.ADMIN_CHANNEL_ID }),
      },
    },
  },
).listen(port);
console.log(`coordinator listening on :${port}`);
