import { makeIntentClassifier, newModels } from "@project-os/agent-runtime/classifier";
import type { AgentRuntimeOptions } from "@project-os/agent-runtime";
import { formatModelRef, modelConfig } from "@project-os/config";
import type { AgentRuntime, Sidekick } from "@project-os/core";
import { Layer } from "effect";
import type { CoordinatorAdapters } from "./assembly.ts";
import { channelDigester } from "./digest/index.ts";
import { emailClassifier } from "./email/index.ts";

/** What a platform's agent runtime is built from. */
export type AgentInput = Pick<AgentRuntimeOptions, "models" | "model" | "adminActions">;

/**
 * The production AI adapter: Pi's models from the model settings. An unknown model fails here,
 * at startup. `agent` is the platform's half: where the chat model runs and keeps its sessions.
 */
export const piAi =
  <E>(
    env: Readonly<Record<string, string | undefined>>,
    agent: (input: AgentInput) => Layer.Layer<AgentRuntime | Sidekick, E>,
  ): CoordinatorAdapters["ai"] =>
  ({ adminActions }) => {
    const models = newModels();
    const refs = modelConfig(env);
    // Checked even where the chat model runs elsewhere (a Durable Object), to fail fast.
    if (!models.getModel(refs.default.provider, refs.default.modelId)) {
      throw new Error(`Unknown DEFAULT_MODEL ${formatModelRef(refs.default)}`);
    }
    const jev = models.getModelOfType("classifier", refs.decision.provider, refs.decision.modelId);
    if (!jev) throw new Error(`Unknown DECISION_MODEL ${formatModelRef(refs.decision)}`);
    return Layer.orDie(
      Layer.mergeAll(
        makeIntentClassifier({ classifier: models, model: jev }),
        agent({ models, model: refs.default, adminActions }),
        channelDigester(models, refs.channelDigest),
        emailClassifier(models, refs.decision),
      ),
    );
  };
