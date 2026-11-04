import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import { WorkerType } from "@project-os/contracts";
import { ClassifierError, IntentClassifier, type IntentResult } from "@project-os/core";
import { Effect, Layer, Schema } from "effect";

/** Pinned, not `~typesafe/jev-latest` (docs/technical-architecture.md §8.6). */
export const JEV_MODEL_ID = "typesafe/jev-1.14";

/** The slice of pi-ai `Models` the classifier needs. */
export interface ClassifyClient {
  readonly classify: (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
  ) => Promise<ClassifierResult>;
}

const INTENTS = {
  new_request: "The user asks for new work to be done",
  follow_up: "The user adds to or changes an open request",
  status_question: "The user asks about the progress or result of existing work",
  admin_command: "The user wants to configure projects, channels or sources",
  chit_chat: "Greeting, thanks or small talk",
  none: "None of the above",
} as const;

const WORKER_TYPES: Record<WorkerType, string> = {
  local_claude: "A local Claude Code session on the developer's machine",
  local_pi: "A local Pi coding agent session",
  daytona_pi: "A Pi agent in a Daytona sandbox",
};

const QUESTIONS: ClassifierContext["questions"] = {
  intent: {
    type: "choice",
    instructions: "What does the message want?",
    criteria: INTENTS,
  },
  worker_type: {
    type: "choice",
    instructions: "Which kind of Worker suits this request? Only meaningful for new requests.",
    criteria: WORKER_TYPES,
  },
  needs_worker: {
    type: "bool",
    instructions:
      "Does answering need a Worker, or can the Coordinator answer from Project Memory?",
    criteria: { true: "A Worker must do work", false: "Answerable from Project Memory" },
  },
};

const isWorkerType = Schema.is(WorkerType);

const choiceOf = (answer: ClassifierAnswer | undefined) =>
  answer?.type === "choice" ? answer : undefined;

const toResult = (result: ClassifierResult): IntentResult => {
  const intent = choiceOf(result.answers.intent);
  if (!intent) throw new ClassifierError({ message: "classifier returned no `intent` answer" });
  const worker = choiceOf(result.answers.worker_type);
  const needs = result.answers.needs_worker;
  return {
    intent: intent.choice,
    confidence: intent.confidence,
    ...(intent.choice === "new_request" && worker && isWorkerType(worker.choice)
      ? { workerType: worker.choice }
      : {}),
    ...(needs?.type === "bool" ? { needsWorker: needs.probability >= 0.5 } : {}),
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
