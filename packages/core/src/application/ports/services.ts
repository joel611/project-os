import type {
  ChannelType,
  ConnectionProvider,
  CreateChannelInstruction,
  CreatedChannel,
  CreatedThread,
  CreateThreadInstruction,
  ReactInstruction,
  ResolveAttachmentsInstruction,
  ResolvedAttachments,
  PostedPrompt,
  PromptInstruction,
  ReplyInstruction,
  SandboxWorkerType,
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
    /** Ask the matching Channel Adapter to react to a message (the 👀 acknowledgement). */
    readonly react: (request: ReactInstruction) => Effect.Effect<void, ReactionFailed>;
    /** Ask the matching Channel Adapter for a message's files with fresh download links. */
    readonly resolveAttachments: (
      request: ResolveAttachmentsInstruction,
    ) => Effect.Effect<ResolvedAttachments, AttachmentsResolveFailed>;
    /** Ask the matching Channel Adapter to post a question answered with a click (buttons). */
    readonly ask: (request: PromptInstruction) => Effect.Effect<PostedPrompt, PromptSendFailed>;
  }
>()("@project-os/core/ChannelGateway") {}

/** A stored file, streamed back. */
export interface AssetObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly size: number;
}

/**
 * Files people sent with their requests, copied out of the channel at intake so a Worker can
 * still fetch them after the message is deleted. Keys are `<ticketId>/<attachmentId>/<name>`.
 */
export class AssetStore extends Context.Service<
  AssetStore,
  {
    /**
     * Downloads `url` and stores it under `key`, streaming. Fails when the download is refused,
     * the file turns out bigger than `maxBytes`, or the write fails.
     */
    readonly ingest: (input: {
      readonly key: string;
      readonly url: string;
      readonly contentType: string | null;
      readonly size: number;
      readonly maxBytes: number;
    }) => Effect.Effect<void, AssetStoreFailed>;
    /** The stored file; undefined when nothing is stored under `key`. */
    readonly get: (key: string) => Effect.Effect<AssetObject | undefined, AssetStoreFailed>;
    /** A short-lived signed download URL for `key`; undefined when links aren't configured. */
    readonly link: (key: string) => Effect.Effect<string | undefined>;
    /** Whether `sig` is a valid, unexpired signature for `key`. */
    readonly verify: (key: string, expires: number, sig: string) => Effect.Effect<boolean>;
    /**
     * A short-lived signed URL a Worker PUTs a file to, to store it under `key`; undefined when
     * links aren't configured. Not interchangeable with `link`: a download link can't upload.
     * `expiresInSeconds` is how long the link works.
     */
    readonly uploadLink: (
      key: string,
    ) => Effect.Effect<{ readonly url: string; readonly expiresInSeconds: number } | undefined>;
    /** Whether `sig` is a valid, unexpired upload signature for `key`. */
    readonly verifyUpload: (key: string, expires: number, sig: string) => Effect.Effect<boolean>;
    /**
     * Stores `body` (exactly `size` bytes, streamed) under `key`. Fails when it runs past
     * `maxBytes` or the write fails.
     */
    readonly put: (input: {
      readonly key: string;
      readonly body: ReadableStream<Uint8Array>;
      readonly contentType: string;
      readonly size: number;
      readonly maxBytes: number;
    }) => Effect.Effect<void, AssetStoreFailed>;
  }
>()("@project-os/core/AssetStore") {}

/** The download, size check or write of a stored file failed. */
export class AssetStoreFailed extends Data.TaggedError("AssetStoreFailed")<{
  readonly message: string;
}> {}

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

/** A Channel Adapter could not react to a message (no permission, message gone, ...). */
export class ReactionFailed extends Data.TaggedError("ReactionFailed")<{
  readonly channelType: string;
  readonly message: string;
}> {}

/** A Channel Adapter could not read a message's files (message deleted, no access, ...). */
export class AttachmentsResolveFailed extends Data.TaggedError("AttachmentsResolveFailed")<{
  readonly channelType: string;
  readonly message: string;
}> {}

/** A Channel Adapter could not post a prompt (no adapter, no permission, ...). */
export class PromptSendFailed extends Data.TaggedError("PromptSendFailed")<{
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
  /**
   * Who does a new request. `worker`: it needs the repo checked out, tests run, or a script
   * run. `sidekick`: read-only lookups through Google Drive or GitHub tools. Unset: `worker`.
   */
  readonly executor?: Executor;
  /** The classifier's probability for every intent option; the audit log's "why". */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** The executor question's raw answer, before the Sidekick confidence floor drops it. */
  readonly executorAnswer?: {
    readonly choice: string;
    readonly confidence: number;
    readonly probabilities: Readonly<Record<string, number>>;
  };
  /** The model that answered, as `provider/model`. */
  readonly model?: string;
  /** Only when `ticketContext` was given: is the message about that ticket? */
  readonly scope?: { readonly choice: TicketScope; readonly confidence: number };
}

export type Executor = "worker" | "sidekick";

export type TicketScope = "in_scope" | "out_of_scope";

export class IntentClassifier extends Context.Service<
  IntentClassifier,
  {
    readonly classify: (input: {
      readonly content: string;
      readonly projectContext: string;
      /** The ticket whose thread the message was said in (see `ticketContext`). */
      readonly ticketContext?: string;
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

/** The Channel Digest's model call failed (provider, auth, or an answer it couldn't read). */
export class ChannelDigestError extends Data.TaggedError("ChannelDigestError")<{
  readonly message: string;
}> {}

/** One thing worth remembering from a channel conversation. */
export interface DigestPoint {
  readonly type: "decision" | "note";
  /** Short headline, a sentence at most. */
  readonly title: string;
  /** The point itself, standing on its own: who decided what, and why if it was said. */
  readonly content: string;
  /** `externalId`s of the messages it came from. */
  readonly messageIds: ReadonlyArray<string>;
}

/**
 * Reads a stretch of a project channel's conversation and picks out the decisions and lasting
 * facts, skipping ones the project already remembers. Usually finds nothing.
 */
export class ChannelDigester extends Context.Service<
  ChannelDigester,
  {
    readonly digest: (input: {
      readonly projectName: string;
      readonly projectContext: string;
      /** Titles of the project's recent memory entries, so it doesn't save them twice. */
      readonly known: ReadonlyArray<string>;
      readonly messages: ReadonlyArray<{
        readonly id: string;
        readonly sender: string;
        readonly content: string;
        readonly sentAt: string;
        /** Set when said in a ticket thread rather than the channel itself. */
        readonly threadId?: string;
      }>;
    }) => Effect.Effect<ReadonlyArray<DigestPoint>, ChannelDigestError>;
  }
>()("@project-os/core/ChannelDigester") {}

export class SidekickError extends Data.TaggedError("SidekickError")<{
  readonly message: string;
}> {}

/** An access token for the person a Sidekick answers, or the reason there is none. */
export type SidekickToken =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly message: string };

/**
 * The Sidekick sits next to the Coordinator and answers tool-only requests (list a Drive
 * folder, read a repo's status, history, pipelines or releases) with read-only Drive and
 * GitHub tools, acting with the requester's own token. It has no shell and no checkout.
 */
export class Sidekick extends Context.Service<
  Sidekick,
  {
    /** One turn of the ticket's Sidekick conversation. */
    readonly answer: (input: {
      readonly ticketId: string;
      readonly prompt: string;
      /** Idempotency key: a re-delivered request is not answered twice. Use the inbound `externalId`. */
      readonly requestId?: string;
      /** The requester's token for `provider`. Called only when a tool needs it. */
      readonly token: (provider: ConnectionProvider) => Promise<SidekickToken>;
    }) => Effect.Effect<string, SidekickError>;
  }
>()("@project-os/core/Sidekick") {}

/** One sandbox provider the Coordinator may start workers on. */
export interface SandboxPoolEntry {
  readonly workerType: SandboxWorkerType;
  /** Most of its tickets active at once; further tickets go to the next provider. Unset: no cap. */
  readonly maxConcurrent?: number;
  /** Longest a session runs before the provider stops it. Unset: 30 minutes. */
  readonly sessionTimeoutSeconds?: number;
}

/** A sandbox session could not be started. */
export class LaunchFailed extends Data.TaggedError("LaunchFailed")<{
  readonly message: string;
}> {}

export class WorkerLauncher extends Context.Service<
  WorkerLauncher,
  {
    /**
     * The sandbox pool: providers this launcher can start, in the order the Coordinator should
     * try them. Empty when no sandbox provider is configured.
     */
    readonly pool: Effect.Effect<ReadonlyArray<SandboxPoolEntry>>;
    /**
     * Start a sandbox session for a ticket just assigned to the pool. Returns once the launch is
     * under way, not when the session ends. Fails `LaunchFailed` when it could not be started
     * at all (a failure after kickoff is the launcher's to log); the ticket then goes back to
     * the queue. Registered devices are never launched: their Watcher pulls the ticket.
     */
    readonly launch: (input: {
      readonly ticketId: string;
      readonly workerType: WorkerType;
      /** The id the ticket is assigned to; the session must claim as this worker. */
      readonly workerId: string;
      /** The session's Bearer token for MCP: it acts as `workerId` only, until it expires. */
      readonly mcpToken: string;
    }) => Effect.Effect<void, LaunchFailed>;
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
  readonly displayIdentity?: string;
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
