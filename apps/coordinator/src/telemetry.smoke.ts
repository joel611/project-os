import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeAgentRuntime } from "@project-os/agent-runtime";
import { AgentRuntime } from "@project-os/core";
import { Context, Effect, Layer } from "effect";
import { setupTelemetry } from "./telemetry.ts";

const setup = setupTelemetry(process.env);
if (!setup) throw new Error("set OTEL_EXPORTER_OTLP_ENDPOINT");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const m = faux.getModel();
faux.setResponses([fauxAssistantMessage([fauxText("smoke ok")])]);

const reply = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(
        makeAgentRuntime({
          storage: new MemoryStorage(),
          models,
          model: { provider: m.provider, modelId: m.id },
          telemetry: setup.telemetry,
        }),
      );
      return yield* Context.get(ctx, AgentRuntime).respond({
        sessionId: "project:smoke",
        prompt: "hello",
      });
    }),
  ),
);
console.log("reply:", reply);
await setup.shutdown();
process.exit(0);
