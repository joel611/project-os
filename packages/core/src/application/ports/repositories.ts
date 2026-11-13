import type {
  ChannelMessage,
  InboundLogEntry,
  ChannelType,
  MemoryEntry,
  MemoryEntryType,
  Requester,
} from "@project-os/contracts";
import { Context, type Effect } from "effect";
import type { Project, ProjectNotFound } from "../../domain/project/index.ts";
import type {
  ProjectSource,
  ProjectSourceType,
  SourceAlreadyLinked,
  SourceAliasTaken,
  SourceNotFound,
} from "../../domain/project-source/index.ts";
import type {
  ClaimConflict,
  InvalidTransition,
  Ticket,
  TicketEvent,
  TicketNotFound,
  TicketStatus,
  TicketThread,
} from "../../domain/ticket/index.ts";
import type { Worker, WorkerNotFound, WorkerType } from "../../domain/worker/index.ts";

export class TicketRepository extends Context.Service<
  TicketRepository,
  {
    readonly insert: (ticket: Ticket) => Effect.Effect<Ticket>;
    readonly get: (id: string) => Effect.Effect<Ticket, TicketNotFound>;
    /** Tickets in `assigned` for this worker, oldest `assignedAt` first. */
    readonly listAssigned: (workerId: string) => Effect.Effect<ReadonlyArray<Ticket>>;
    readonly listByStatus: (
      statuses: ReadonlyArray<TicketStatus>,
    ) => Effect.Effect<ReadonlyArray<Ticket>>;
    /** `open → assigned`, stamping the worker. `workerId` null = any worker of that type. */
    readonly assign: (
      ticketId: string,
      worker: { readonly workerType: WorkerType; readonly workerId: string | null },
      at: string,
    ) => Effect.Effect<Ticket, TicketNotFound | InvalidTransition>;
    /**
     * Atomic `assigned → open` for a ticket still `assigned` to `workerId`: clears the worker
     * so the ticket is Queued again, keeping its `createdAt`. Fails `InvalidTransition` once
     * the worker has claimed it (or it was released or reassigned).
     */
    readonly release: (
      ticketId: string,
      workerId: string,
      at: string,
    ) => Effect.Effect<Ticket, TicketNotFound | InvalidTransition>;
    /** Atomic `assigned → in_progress`. Two concurrent claims: exactly one wins. */
    readonly claim: (
      ticketId: string,
      workerId: string,
      at: string,
    ) => Effect.Effect<Ticket, TicketNotFound | ClaimConflict>;
    readonly updateStatus: (
      ticketId: string,
      to: TicketStatus,
      at: string,
      extra?: { readonly result?: unknown; readonly error?: string | null },
    ) => Effect.Effect<Ticket, TicketNotFound | InvalidTransition>;
    /** Appends the event and bumps the ticket's `lastActivityAt`. */
    readonly appendEvent: (event: TicketEvent) => Effect.Effect<TicketEvent, TicketNotFound>;
    readonly listEvents: (
      ticketId: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<TicketEvent>, TicketNotFound>;
    /** Records the channel thread a ticket's conversation lives in (one per ticket). */
    readonly linkThread: (thread: TicketThread) => Effect.Effect<TicketThread, TicketNotFound>;
    /** The ticket's thread, if it has one. */
    readonly findThread: (ticketId: string) => Effect.Effect<TicketThread | undefined>;
    /** Thread → ticket lookup. `undefined` when the thread is not a ticket's. */
    readonly findByThread: (
      channelType: TicketThread["channelType"],
      threadId: string,
    ) => Effect.Effect<TicketThread | undefined>;
    /**
     * Tickets this person is involved in: they asked for it (`requester`), or wrote its first
     * message or a follow-up (a message in its thread, an answer to one of its prompts). Newest
     * `lastActivityAt` first.
     */
    readonly listInvolving: (person: Requester) => Effect.Effect<ReadonlyArray<Ticket>>;
    /** Events on every ticket with `createdAt >= since`: the newest `limit`, oldest first. */
    readonly listEventsSince: (
      since: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TicketEvent>>;
  }
>()("@project-os/core/TicketRepository") {}

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    readonly insert: (project: Project) => Effect.Effect<Project>;
    readonly get: (id: string) => Effect.Effect<Project, ProjectNotFound>;
    readonly list: Effect.Effect<ReadonlyArray<Project>>;
    /** Replaces the stored row with the same id. */
    readonly update: (project: Project) => Effect.Effect<Project, ProjectNotFound>;
  }
>()("@project-os/core/ProjectRepository") {}

export class ProjectSourceRepository extends Context.Service<
  ProjectSourceRepository,
  {
    /**
     * Fails with `SourceAlreadyLinked` if `(type, externalId)` exists (1:1 channel → project),
     * or `SourceAliasTaken` if the project already has a source with this alias.
     */
    readonly insert: (
      source: ProjectSource,
    ) => Effect.Effect<ProjectSource, SourceAlreadyLinked | SourceAliasTaken>;
    /** Channel → project lookup. `undefined` when the channel is not linked. */
    readonly findByExternal: (
      type: ProjectSourceType,
      externalId: string,
    ) => Effect.Effect<ProjectSource | undefined>;
    readonly listByProject: (projectId: string) => Effect.Effect<ReadonlyArray<ProjectSource>>;
    /** Marks one source as the project's default response; clears the flag on the others. */
    readonly setDefaultResponse: (
      projectId: string,
      sourceId: string,
    ) => Effect.Effect<ProjectSource, SourceNotFound>;
    /** Changes a source's alias and/or description. Fails if the alias is taken in the project. */
    readonly update: (
      projectId: string,
      sourceId: string,
      patch: {
        readonly alias?: string;
        readonly description?: string | null;
        readonly updatedAt: string;
      },
    ) => Effect.Effect<ProjectSource, SourceNotFound | SourceAliasTaken>;
    /**
     * Deletes a project's source and returns it. Its `(type, externalId)` is free to link again,
     * and a channel it named stops routing to the project.
     */
    readonly remove: (
      projectId: string,
      sourceId: string,
    ) => Effect.Effect<ProjectSource, SourceNotFound>;
  }
>()("@project-os/core/ProjectSourceRepository") {}

export class MemoryRepository extends Context.Service<
  MemoryRepository,
  {
    readonly insert: (entry: MemoryEntry) => Effect.Effect<MemoryEntry>;
    /** Newest first. */
    readonly list: (
      projectId: string,
      options?: { readonly type?: MemoryEntryType; readonly limit?: number },
    ) => Effect.Effect<ReadonlyArray<MemoryEntry>>;
    readonly search: (
      projectId: string,
      query: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<MemoryEntry>>;
  }
>()("@project-os/core/MemoryRepository") {}

/** A project with channel messages the Channel Digest hasn't read yet. */
export interface PendingChannel {
  readonly projectId: string;
  readonly count: number;
  /** `sentAt` of its oldest and newest waiting message. */
  readonly oldestAt: string;
  readonly newestAt: string;
}

/** Channel messages held for the Channel Digest. Digested rows are removed. */
export class ChannelMessageRepository extends Context.Service<
  ChannelMessageRepository,
  {
    /** Stores a message; false when one with the same `(channelType, externalId)` is already there. */
    readonly append: (message: ChannelMessage) => Effect.Effect<boolean>;
    /** Projects with waiting messages. */
    readonly pending: Effect.Effect<ReadonlyArray<PendingChannel>>;
    /** A project's waiting messages, oldest first. */
    readonly list: (
      projectId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ChannelMessage>>;
    readonly remove: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
    /** Drops messages sent before `at` (ones a failing digest never got to). Returns how many. */
    readonly removeSentBefore: (at: string) => Effect.Effect<number>;
  }
>()("@project-os/core/ChannelMessageRepository") {}

/** Every message received in a project's channels, newest first on read. For debugging intake. */
export class InboundLogRepository extends Context.Service<
  InboundLogRepository,
  {
    /** Stores an entry; false when one with the same `(channelType, externalId)` is already there. */
    readonly append: (entry: InboundLogEntry) => Effect.Effect<boolean>;
    /** A project's most recent entries, newest first. */
    readonly list: (
      projectId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<InboundLogEntry>>;
  }
>()("@project-os/core/InboundLogRepository") {}

export class WorkerRepository extends Context.Service<
  WorkerRepository,
  {
    /** Registers the worker on first heartbeat, else updates `lastSeenAt` / `currentTicketId`. */
    readonly heartbeat: (input: {
      readonly workerId: string;
      readonly workerType: WorkerType;
      readonly ticketId: string | null;
      readonly at: string;
    }) => Effect.Effect<Worker>;
    readonly get: (id: string) => Effect.Effect<Worker, WorkerNotFound>;
    readonly list: Effect.Effect<ReadonlyArray<Worker>>;
    /**
     * Creates a registered device, authenticated by `secretHash`: a personal worker owned by
     * one person, or (owner null) a shared worker an admin added to the pool.
     */
    readonly register: (input: {
      readonly id: string;
      readonly workerType: WorkerType;
      readonly owner: { readonly channelType: ChannelType; readonly id: string } | null;
      readonly name: string;
      readonly secretHash: string;
      readonly at: string;
    }) => Effect.Effect<Worker>;
    /** The registered worker whose secret hashes to `secretHash`, if any. */
    readonly findBySecretHash: (secretHash: string) => Effect.Effect<Worker | undefined>;
    /** Personal workers this person registered. */
    readonly listByOwner: (
      channelType: ChannelType,
      ownerId: string,
    ) => Effect.Effect<ReadonlyArray<Worker>>;
    /** Deletes the worker (its secret stops working). Returns false if there was none. */
    readonly remove: (id: string) => Effect.Effect<boolean>;
  }
>()("@project-os/core/WorkerRepository") {}
