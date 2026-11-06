import type {
  ChannelType,
  ConnectionProvider,
  CreateChannelInstruction,
  CreatedChannel,
  CreatedThread,
  CreateThreadInstruction,
  ReplyInstruction,
  WorkerType,
} from "@project-os/contracts";
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
    /** Ask the matching Channel Adapter to create a channel (e.g. a project's Discord channel). */
    readonly createChannel: (
      request: CreateChannelInstruction,
    ) => Effect.Effect<CreatedChannel, ChannelCreateFailed>;
    /** Ask the matching Channel Adapter to open a thread on a message (a Ticket's thread). */
    readonly createThread: (
      request: CreateThreadInstruction,
    ) => Effect.Effect<CreatedThread, ThreadCreateFailed>;
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

/** A Channel Adapter could not create a channel (missing permission, no adapter, ...). */
export class ChannelCreateFailed extends Data.TaggedError("ChannelCreateFailed")<{
  readonly channelType: string;
  readonly message: string;
}> {}

/** A Channel Adapter could not open a thread (no permission, unsupported channel, ...). */
export class ThreadCreateFailed extends Data.TaggedError("ThreadCreateFailed")<{
  readonly channelType: string;
  readonly message: string;
}> {}

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

/** Someone who wrote to the Coordinator, identified by their channel's own user id. */
export interface Person {
  readonly channelType: ChannelType;
  readonly id: string;
  readonly name?: string;
}

/** A person's access token for a linked provider, refreshed if it was about to expire. */
export interface UserAccessToken {
  readonly accessToken: string;
  readonly expiresAt: string | null;
  readonly scopes: ReadonlyArray<string>;
}

export interface LinkedAccount {
  readonly provider: ConnectionProvider;
  /** The provider's account id. */
  readonly accountId: string;
}

/**
 * Per-person links to third-party accounts (Google, GitHub). Workers act with the token of
 * the person who asked, so the provider's own permissions decide what they can reach.
 */
export class UserConnections extends Context.Service<
  UserConnections,
  {
    /** A short-lived, one-time URL that links `provider` to `person` when opened. */
    readonly connectUrl: (
      person: Person,
      provider: ConnectionProvider,
    ) => Effect.Effect<string, ConnectionsUnavailable>;
    readonly list: (person: Person) => Effect.Effect<ReadonlyArray<LinkedAccount>>;
    /** Removes the link. Returns false if there was none. */
    readonly disconnect: (person: Person, provider: ConnectionProvider) => Effect.Effect<boolean>;
    readonly accessToken: (
      person: Person,
      provider: ConnectionProvider,
    ) => Effect.Effect<UserAccessToken, NotConnected | ConnectionsUnavailable>;
  }
>()("@project-os/core/UserConnections") {}

/** The person has not linked `provider`, or the link was revoked and needs redoing. */
export class NotConnected extends Data.TaggedError("NotConnected")<{
  readonly provider: ConnectionProvider;
  readonly personId: string;
  readonly message: string;
}> {}

/** Account linking is not configured here (no secret, or no client for the provider). */
export class ConnectionsUnavailable extends Data.TaggedError("ConnectionsUnavailable")<{
  readonly message: string;
}> {}
