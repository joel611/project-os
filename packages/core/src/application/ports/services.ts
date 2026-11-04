import type { ReplyInstruction, WorkerType } from "@project-os/contracts";
import { Context, Data, type Effect } from "effect";

export class KeyValueStore extends Context.Service<
  KeyValueStore,
  {
    readonly get: (key: string) => Effect.Effect<string | undefined>;
    readonly set: (
      key: string,
      value: string,
      options?: { readonly ttlSeconds?: number },
    ) => Effect.Effect<void>;
    /** Set only if absent. Returns true if written. Used to dedupe inbound messages. */
    readonly setIfAbsent: (
      key: string,
      value: string,
      options?: { readonly ttlSeconds?: number },
    ) => Effect.Effect<boolean>;
    readonly delete: (key: string) => Effect.Effect<void>;
  }
>()("@project-os/core/KeyValueStore") {}

export class ChannelGateway extends Context.Service<
  ChannelGateway,
  {
    /** Send a reply instruction to the matching Channel Adapter. */
    readonly send: (reply: ReplyInstruction) => Effect.Effect<void>;
  }
>()("@project-os/core/ChannelGateway") {}

export class Scheduler extends Context.Service<
  Scheduler,
  {
    /** Run `task` every `everyMs` until the returned effect (stop) runs. */
    readonly every: (
      name: string,
      everyMs: number,
      task: Effect.Effect<void>,
    ) => Effect.Effect<Effect.Effect<void>>;
  }
>()("@project-os/core/Scheduler") {}

/** The classifier call failed (provider, auth, or malformed response). */
export class ClassifierError extends Data.TaggedError("ClassifierError")<{
  readonly message: string;
}> {}

/** The agent runtime could not produce an answer. */
export class AgentRuntimeError extends Data.TaggedError("AgentRuntimeError")<{
  readonly message: string;
}> {}

export interface IntentResult {
  readonly intent: string;
  readonly confidence: number;
  /** Only meaningful for `new_request`. Falls back to the configured default. */
  readonly workerType?: WorkerType;
  /** Whether a Worker is needed, or the Coordinator can answer from Project Memory. */
  readonly needsWorker?: boolean;
}

export class IntentClassifier extends Context.Service<
  IntentClassifier,
  {
    readonly classify: (input: {
      readonly content: string;
      readonly projectContext: string;
    }) => Effect.Effect<IntentResult, ClassifierError>;
  }
>()("@project-os/core/IntentClassifier") {}

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    /** One turn of the Coordinator conversation (reply composition, admin dialogue). */
    readonly respond: (input: {
      readonly sessionId: string;
      readonly prompt: string;
      /** Idempotency key: a re-delivered request is not answered twice. Use the inbound `externalId`. */
      readonly requestId?: string;
    }) => Effect.Effect<string, AgentRuntimeError>;
  }
>()("@project-os/core/AgentRuntime") {}

export class WorkerLauncher extends Context.Service<
  WorkerLauncher,
  {
    /** Start a worker for a ticket (Daytona later). No-op for pull-model local workers. */
    readonly launch: (input: {
      readonly ticketId: string;
      readonly workerType: WorkerType;
    }) => Effect.Effect<void>;
  }
>()("@project-os/core/WorkerLauncher") {}

export class IdGenerator extends Context.Service<
  IdGenerator,
  {
    readonly next: Effect.Effect<string>;
  }
>()("@project-os/core/IdGenerator") {}
