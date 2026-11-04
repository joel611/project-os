import type { MemoryEntry, MemoryEntryType } from "@project-os/contracts";
import { Context, type Effect } from "effect";
import type { Project, ProjectNotFound } from "../../domain/project/index.ts";
import type {
  ProjectSource,
  ProjectSourceType,
  SourceAlreadyLinked,
  SourceNotFound,
} from "../../domain/project-source/index.ts";
import type {
  ClaimConflict,
  InvalidTransition,
  Ticket,
  TicketEvent,
  TicketNotFound,
  TicketStatus,
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
  }
>()("@project-os/core/TicketRepository") {}

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    readonly insert: (project: Project) => Effect.Effect<Project>;
    readonly get: (id: string) => Effect.Effect<Project, ProjectNotFound>;
    readonly list: Effect.Effect<ReadonlyArray<Project>>;
  }
>()("@project-os/core/ProjectRepository") {}

export class ProjectSourceRepository extends Context.Service<
  ProjectSourceRepository,
  {
    /** Fails with `SourceAlreadyLinked` if `(type, externalId)` exists (1:1 channel → project). */
    readonly insert: (source: ProjectSource) => Effect.Effect<ProjectSource, SourceAlreadyLinked>;
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
  }
>()("@project-os/core/WorkerRepository") {}
