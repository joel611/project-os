import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { ClassifierError, IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeIntentClassifier, newModels } from "./index.ts";

/** The model id of `DEFAULT_DECISION_MODEL` (libs/config). */
const JEV_MODEL_ID = "typesafe/jev-1.14";

const choice = (c: string, confidence: number) => ({
  type: "choice" as const,
  choice: c,
  probabilities: { [c]: confidence },
  confidence,
});

/** A classifier provider with scripted results; records every request. */
const scripted = (result: Partial<ClassifierResult>) => {
  const requests: ClassifierContext[] = [];
  const models = newModels();
  const model = models.getModelOfType("classifier", "openrouter", JEV_MODEL_ID)!;
  const classify = async (_m: unknown, context: ClassifierContext): Promise<ClassifierResult> => {
    requests.push(context);
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      answers: {},
      stopReason: "stop",
      timestamp: 0,
      ...result,
    };
  };
  return { requests, model, classifier: { classify } };
};

const classifyEffect = (content = "fix the login bug") =>
  Effect.gen(function* () {
    const c = yield* IntentClassifier;
    return yield* c.classify({ content, projectContext: "Acme web app" });
  });

const call = (layer: Layer.Layer<IntentClassifier>) =>
  Effect.runPromise(Effect.provide(classifyEffect(), layer));

describe("catalog", () => {
  it("pins the Jev model on OpenRouter", () => {
    expect(newModels().getModelOfType("classifier", "openrouter", JEV_MODEL_ID)).toBeDefined();
  });
});

describe("makeIntentClassifier", () => {
  it("sends one request with intent and executor and returns choices + confidence", async () => {
    const s = scripted({
      answers: {
        intent: choice("new_request", 0.9),
        executor: choice("sidekick", 0.95),
      },
    });
    const result = await call(makeIntentClassifier(s));

    expect(result).toEqual({
      intent: "new_request",
      confidence: 0.9,
      executor: "sidekick",
      probabilities: { new_request: 0.9 },
      executorAnswer: { choice: "sidekick", confidence: 0.95, probabilities: { sidekick: 0.95 } },
      model: `openrouter/${JEV_MODEL_ID}`,
    });
    expect(s.requests).toHaveLength(1);
    const [req] = s.requests;
    expect(Object.keys(req!.questions)).toEqual(["intent", "executor"]);
    expect(Object.keys((req!.questions.intent as { criteria: object }).criteria)).toEqual([
      "new_request",
      "follow_up",
      "status_question",
      "remember",
      "admin_command",
      "chit_chat",
      "none",
    ]);
    expect(req!.state).toEqual({ message: "fix the login bug", project_context: "Acme web app" });
  });

  it("omits the executor unless the intent is new_request", async () => {
    const s = scripted({
      answers: {
        intent: choice("status_question", 0.7),
        executor: choice("sidekick", 0.9),
      },
    });
    const result = await call(makeIntentClassifier(s));
    expect(result).toMatchObject({ intent: "status_question", confidence: 0.7 });
    expect(result.executor).toBeUndefined();
    // The raw answer is still kept for the audit log.
    expect(result.executorAnswer?.choice).toBe("sidekick");
  });

  it("ignores an answer the classifier wasn't asked for", async () => {
    const s = scripted({
      answers: { intent: choice("new_request", 0.9), worker_type: choice("local", 0.9) },
    });
    const result = await call(makeIntentClassifier(s));
    expect(result).toEqual({
      intent: "new_request",
      confidence: 0.9,
      probabilities: { new_request: 0.9 },
      model: `openrouter/${JEV_MODEL_ID}`,
    });
  });

  it("keeps every intent option's probability for the audit log", async () => {
    const s = scripted({
      answers: {
        intent: {
          type: "choice",
          choice: "follow_up",
          probabilities: { follow_up: 0.6, new_request: 0.3, none: 0.1 },
          confidence: 0.6,
        },
      },
    });
    const result = await call(makeIntentClassifier(s));
    expect(result.probabilities).toEqual({ follow_up: 0.6, new_request: 0.3, none: 0.1 });
  });

  it("describes the executor choice by what the job needs", async () => {
    const s = scripted({ answers: { intent: choice("new_request", 0.9) } });
    await call(makeIntentClassifier(s));
    const executor = s.requests[0]!.questions.executor as { criteria: Record<string, string> };
    expect(Object.keys(executor.criteria)).toEqual(["worker", "sidekick"]);
    expect(executor.criteria.worker).toMatch(/repository.*tests.*script/);
    expect(executor.criteria.sidekick).toMatch(/Drive.*GitHub/);
  });

  it("sends a doubtful or unknown executor to a Worker by leaving it unset", async () => {
    for (const executor of [choice("sidekick", 0.4), choice("bogus", 0.99)]) {
      const s = scripted({ answers: { intent: choice("new_request", 0.9), executor } });
      expect((await call(makeIntentClassifier(s))).executor).toBeUndefined();
    }
  });

  it("maps stopReason error to ClassifierError", async () => {
    const s = scripted({ stopReason: "error", errorMessage: "401 unauthorized" });
    const err = await Effect.runPromise(
      Effect.flip(Effect.provide(classifyEffect("x"), makeIntentClassifier(s))),
    );
    expect(err).toBeInstanceOf(ClassifierError);
    expect(err.message).toContain("401 unauthorized");
  });

  it("fails when the intent answer is missing", async () => {
    const s = scripted({ answers: {} });
    await expect(call(makeIntentClassifier(s))).rejects.toThrow(/intent/);
  });

  it("maps a rejected classify call to ClassifierError", async () => {
    const s = scripted({});
    const layer = makeIntentClassifier({
      ...s,
      classifier: {
        classify: async () => {
          throw new Error("network down");
        },
      },
    });
    await expect(call(layer)).rejects.toThrow(/network down/);
  });

  it("names a non-Error rejection", async () => {
    const s = scripted({});
    const layer = makeIntentClassifier({
      ...s,
      classifier: { classify: () => Promise.reject("boom") },
    });
    await expect(call(layer)).rejects.toThrow(/boom/);
  });

  it("uses a default message when the provider gives none", async () => {
    const s = scripted({ stopReason: "aborted" });
    await expect(call(makeIntentClassifier(s))).rejects.toThrow(/aborted/);
  });
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)("live Jev (opt-in)", () => {
  it("classifies a clear request", async () => {
    const models = newModels();
    const model = models.getModelOfType("classifier", "openrouter", JEV_MODEL_ID)!;
    const result = await call(makeIntentClassifier({ classifier: models, model }));
    expect(result.confidence).toBeGreaterThan(0);
  });
});
