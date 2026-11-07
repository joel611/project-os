import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import { WorkerType } from "@project-os/contracts";
import {
  ClassifierError,
  type Executor,
  IntentClassifier,
  type IntentResult,
} from "@project-os/core";
import { Effect, Layer, Schema } from "effect";

/** Pinned, not `~typesafe/jev-latest` (docs/technical-architecture.md §8.6). */
export const JEV_MODEL_ID = "typesafe/jev-1.14";

/** Below this the executor answer is dropped and the request goes to a Worker. */
const SIDEKICK_MIN_CONFIDENCE = 0.7;

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

// One choice for every cloud sandbox: which provider runs it is the sandbox pool's call
// (WORKER_PROVIDERS), not the classifier's.
const WORKER_TYPES: Record<
  Exclude<WorkerType, "sidekick" | "cloudflare_pi" | "boat_pi">,
  string
> = {
  local_claude: "A local Claude Code session on the developer's machine",
  local_pi: "A local Pi coding agent session",
  daytona_pi: "A Pi agent in a cloud sandbox",
};

const EXECUTORS: Record<Executor, string> = {
  worker:
    "Needs the whole repository pulled, tests run, or a script run. Also any request that changes code or files, or that is unclear",
  sidekick:
    "Only needs read-only tool calls: listing Google Drive files, or reading a GitHub repo's status, commit history, pipelines or releases",
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
  executor: {
    type: "choice",
    instructions:
      "Who does this request? A Worker works in a checkout of the repo. The Sidekick only calls read-only Drive and GitHub tools. Only meaningful for new requests.",
    criteria: EXECUTORS,
  },
};

const isExecutor = (value: string): value is Executor => value in EXECUTORS;

const isWorkerType = Schema.is(WorkerType);

const choiceOf = (answer: ClassifierAnswer | undefined) =>
  answer?.type === "choice" ? answer : undefined;

const toResult = (result: ClassifierResult): IntentResult => {
  const intent = choiceOf(result.answers.intent);
  if (!intent) throw new ClassifierError({ message: "classifier returned no `intent` answer" });
  const worker = choiceOf(result.answers.worker_type);
  const executor = choiceOf(result.answers.executor);
  return {
    intent: intent.choice,
    confidence: intent.confidence,
    ...(intent.choice === "new_request" && worker && isWorkerType(worker.choice)
      ? { workerType: worker.choice }
      : {}),
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
