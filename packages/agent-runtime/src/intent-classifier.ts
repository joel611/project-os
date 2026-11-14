import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import {
  ClassifierError,
  type Executor,
  IntentClassifier,
  type IntentResult,
} from "@project-os/core";
import {
  EXECUTOR_CRITERIA,
  EXECUTOR_QUESTION,
  INTENT_CRITERIA,
  INTENT_QUESTION,
} from "@project-os/system-prompts";
import { Effect, Layer } from "effect";

/** Below this the executor answer is dropped and the request goes to a Worker. */
const SIDEKICK_MIN_CONFIDENCE = 0.7;

/** The slice of pi-ai `Models` the classifier needs. */
export interface ClassifyClient {
  readonly classify: (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
  ) => Promise<ClassifierResult>;
}

const EXECUTORS: Record<Executor, string> = EXECUTOR_CRITERIA;

const QUESTIONS: ClassifierContext["questions"] = {
  intent: {
    type: "choice",
    instructions: INTENT_QUESTION,
    criteria: INTENT_CRITERIA,
  },
  executor: {
    type: "choice",
    instructions: EXECUTOR_QUESTION,
    criteria: EXECUTORS,
  },
};

const isExecutor = (value: string): value is Executor => value in EXECUTORS;

const choiceOf = (answer: ClassifierAnswer | undefined) =>
  answer?.type === "choice" ? answer : undefined;

const toResult = (result: ClassifierResult): IntentResult => {
  const intent = choiceOf(result.answers.intent);
  if (!intent) throw new ClassifierError({ message: "classifier returned no `intent` answer" });
  const executor = choiceOf(result.answers.executor);
  return {
    intent: intent.choice,
    confidence: intent.confidence,
    // A Sidekick answer must be sure of itself: a doubtful one goes to a Worker, which can do both.
    ...(intent.choice === "new_request" &&
    executor &&
    isExecutor(executor.choice) &&
    executor.confidence >= SIDEKICK_MIN_CONFIDENCE
      ? { executor: executor.choice }
      : {}),
  };
};

/**
 * Jev behind the `IntentClassifier` port. One request per message, all questions together.
 * The caller applies the confidence threshold. `classify()` reports failure as
 * `stopReason: "error"` rather than throwing; that becomes `ClassifierError`.
 */
export const makeIntentClassifier = (input: {
  readonly classifier: ClassifyClient;
  readonly model: ClassifierModel<ClassifierApi>;
}) =>
  Layer.succeed(IntentClassifier, {
    classify: ({ content, projectContext }) =>
      Effect.tryPromise({
        try: () =>
          input.classifier.classify(input.model, {
            state: { message: content, project_context: projectContext },
            questions: QUESTIONS,
          }),
        catch: (e) => new ClassifierError({ message: e instanceof Error ? e.message : String(e) }),
      }).pipe(
        Effect.flatMap((result) =>
          result.stopReason === "stop"
            ? Effect.try({
                try: () => toResult(result),
                catch: (e) => e as ClassifierError,
              })
            : Effect.fail(
                new ClassifierError({
                  message: result.errorMessage ?? `classify ${result.stopReason}`,
                }),
              ),
        ),
      ),
  });
