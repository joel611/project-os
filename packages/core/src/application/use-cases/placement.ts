import type { WorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import {
  ACTIVE_STATUSES,
  isSharedDevice,
  type Ticket,
  type TicketStatus,
  workerLabel,
  workerStatus,
} from "../../domain/index.ts";
import {
  Clock,
  type Executor,
  IdGenerator,
  type Person,
  TicketRepository,
  WorkerLauncher,
  WorkerRepository,
} from "../ports/index.ts";
import { listPersonalWorkers } from "./personal-workers.ts";
import {
  issueSandboxToken,
  revokeSandboxToken,
  sandboxTokenTtlSeconds,
  sandboxWorkerId,
} from "./sandbox-credentials.ts";
import { SIDEKICK_WORKER_ID } from "./sidekick.ts";
import { taskTypeOf } from "./skills.ts";
import { auditTicket, COORDINATOR } from "./audit.ts";

/** A registered device counts as online if it heartbeat within this window, unless told otherwise. */
export const DEFAULT_WORKER_STALE_MS = 15 * 60 * 1000;

/** How new tickets find a worker. `HandleInboundConfig` and `HealthThresholds` both satisfy it. */
export interface PlacementRouting {
  /** A registered device counts as online if it heartbeat within this window. Default 15 minutes. */
  readonly workerStaleMs?: number;
  /**
   * Tickets a shared device may hold (assigned or in progress) before the next ticket moves
   * on to another shared device or the sandbox pool. Default 1: a Watcher runs one session
   * at a time unless its MAX_SESSIONS says otherwise.
   */
  readonly sharedWorkerMaxTickets?: number;
}

/** Payload `kind` of the system event that marks a ticket as waiting for a worker. */
export const QUEUED_EVENT_KIND = "queued";

export const QUEUED_MESSAGE =
  "No worker is free for this right now, so it's queued. It starts as soon as one has room.";

export interface PlaceRequest {
  /** An `open` ticket with no worker. */
  readonly ticketId: string;
  /** Who asked: their own online device comes first. */
  readonly requester: Person;
  /** `sidekick` is answered in process, assigned and claimed at once; default `worker`. */
  readonly executor?: Executor;
  readonly routing: PlacementRouting;
  /** ISO timestamp for everything written. */
  readonly at: string;
  /**
   * The ticket is already Queued (the health sweep is retrying it), so staying Queued writes
   * nothing new. Otherwise a ticket that ends up Queued gets its marker event.
   */
  readonly alreadyQueued?: boolean;
}

/**
 * `placed`: the ticket has a worker (for a sandbox, its session is under way).
 * `queued`: nobody could take it; it is `open` with no worker, for the health sweep to retry.
 */
export type Placement =
  | { readonly kind: "placed"; readonly ticket: Ticket; readonly workerId: string }
  | { readonly kind: "queued"; readonly ticket: Ticket };

/** Which tickets share a worker's capacity, and how many fit. */
interface Slot {
  readonly limit: number;
  readonly statuses: ReadonlyArray<TicketStatus>;
  readonly holds: (t: Ticket) => boolean;
}

interface Target {
  readonly workerType: WorkerType;
  readonly workerId: string;
  readonly body: string;
  readonly kind: "personal" | "shared" | "sandbox";
  /** Undefined: no cap. */
  readonly slot?: Slot;
}

/** The requester's most recently seen online device. */
const onlinePersonalDevice = (requester: Person, staleMs: number) =>
  Effect.gen(function* () {
    const online = (yield* listPersonalWorkers(requester, staleMs))
      .filter((w) => w.status === "online")
      .map((w) => w.worker)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return online[0];
  });

/**
 * Who works the ticket: the requester's own online device, else the online shared device
 * holding the fewest tickets that is under its cap, else the first sandbox provider in pool
 * order with room. Undefined when none can: the ticket waits, Queued.
 */
const pickTarget = (request: PlaceRequest) =>
  Effect.gen(function* () {
    const { requester, ticketId, routing } = request;
    const tickets = yield* TicketRepository;
    const staleMs = routing.workerStaleMs ?? DEFAULT_WORKER_STALE_MS;

    const personal = yield* onlinePersonalDevice(requester, staleMs);
    if (personal) {
      return {
        workerType: personal.workerType,
        workerId: personal.id,
        body: `Assigned to the requester's own worker ${workerLabel(personal)}`,
        kind: "personal",
      } satisfies Target as Target;
    }

    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const online = (yield* (yield* WorkerRepository).list).filter(
      (w) => isSharedDevice(w) && workerStatus(w, now, staleMs) === "online",
    );
    if (online.length > 0) {
      const held = yield* tickets.listByStatus(["assigned", "in_progress"]);
      const load = (id: string) => held.filter((t) => t.workerId === id).length;
      const limit = routing.sharedWorkerMaxTickets ?? 1;
      const shared = online
        .filter((w) => load(w.id) < limit)
        .sort((a, b) => load(a.id) - load(b.id) || b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
      if (shared) {
        return {
          workerType: shared.workerType,
          workerId: shared.id,
          body: `Assigned to the shared worker ${workerLabel(shared)}`,
          kind: "shared",
          slot: {
            limit,
            statuses: ["assigned", "in_progress"],
            holds: (t) => t.workerId === shared.id,
          },
        } satisfies Target as Target;
      }
    }

    const pool = yield* (yield* WorkerLauncher).pool;
    const capped = pool.some((entry) => entry.maxConcurrent !== undefined);
    const active = capped ? yield* tickets.listByStatus(ACTIVE_STATUSES) : [];
    const sandbox = pool.find(
      (entry) =>
        entry.maxConcurrent === undefined ||
        active.filter((t) => t.workerType === entry.workerType).length < entry.maxConcurrent,
    );
    if (sandbox) {
      // A sandbox session is a fresh worker per ticket, so it gets its own id.
      const workerId = sandboxWorkerId(sandbox.workerType, ticketId);
      return {
        workerType: sandbox.workerType,
        workerId,
        body: `Assigned to ${workerId}`,
        kind: "sandbox",
        ...(sandbox.maxConcurrent !== undefined && {
          slot: {
            limit: sandbox.maxConcurrent,
            statuses: ACTIVE_STATUSES,
            holds: (t: Ticket) => t.workerType === sandbox.workerType,
          },
        }),
      } satisfies Target as Target;
    }
    return undefined;
  });

/**
 * Places a new ticket, or queues it.
 *
 * Order: the requester's own online device, a free shared device, a sandbox from the pool.
 * With none free the ticket stays `open` with no worker (Queued), and the health sweep calls
 * this again for it, oldest first. A `sidekick` ticket skips all that: it is assigned to the
 * Sidekick and claimed at once.
 *
 * Capacity is checked, then acted on, without a lock. So after assigning, the load on that
 * device or provider is counted again; if the ticket is now over the cap, it was the last to
 * take a slot and goes back to Queued. (Two placers that each see the other can both step
 * back; the sweep then places the oldest first.) A sandbox session is launched only after that,
 * and if the launch fails the ticket goes back to Queued too. Retrying is the health sweep's
 * job.
 */
export const placeOrQueue = (request: PlaceRequest) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const ids = yield* IdGenerator;
    const { ticketId, at } = request;

    const assignedEvent = (body: string, payload: unknown) =>
      Effect.flatMap(ids.next, (id) =>
        tickets.appendEvent({
          id,
          ticketId,
          type: "assigned",
          actor: "coordinator",
          actorId: null,
          body,
          payload,
          createdAt: at,
        }),
      );

    const queued = (reason: string) =>
      Effect.gen(function* () {
        if (request.alreadyQueued !== true) {
          yield* tickets.appendEvent({
            id: yield* ids.next,
            ticketId,
            type: "system",
            actor: "coordinator",
            actorId: null,
            body: `Queued: ${reason}`,
            payload: { kind: QUEUED_EVENT_KIND },
            createdAt: at,
          });
        }
        return {
          kind: "queued",
          ticket: yield* tickets.get(ticketId),
        } satisfies Placement as Placement;
      });

    /**
     * Takes a ticket back from its worker. True once it is Queued (also when someone else got
     * there first); false if the worker already claimed it, so it stays where it is.
     */
    const giveBack = (id: string, workerId: string, reason: string) =>
      Effect.logWarning(`ticket ${id} goes back to the queue: ${reason}`).pipe(
        Effect.andThen(tickets.release(id, workerId, at)),
        Effect.tap((released) => auditTicket(released, "released", COORDINATOR, { reason, at })),
        Effect.as(true),
        Effect.catchTag("InvalidTransition", () =>
          Effect.map(tickets.get(id), (current) => current.status === "open"),
        ),
        Effect.orDie,
      );

    if (request.executor === "sidekick") {
      const toSidekick = yield* tickets.assign(
        ticketId,
        { workerType: "sidekick", workerId: SIDEKICK_WORKER_ID },
        at,
      );
      yield* auditTicket(toSidekick, "assigned", COORDINATOR, { from: "open", at });
      yield* assignedEvent("Assigned to the Sidekick", {
        workerType: "sidekick",
        workerId: SIDEKICK_WORKER_ID,
      });
      // Just assigned to this id in this turn, so a conflict is a bug, not a state to report.
      const claimed = yield* Effect.orDie(tickets.claim(ticketId, SIDEKICK_WORKER_ID, at));
      yield* auditTicket(claimed, "claimed", { type: "worker", id: SIDEKICK_WORKER_ID }, { at });
      return {
        kind: "placed",
        ticket: claimed,
        workerId: SIDEKICK_WORKER_ID,
      } satisfies Placement as Placement;
    }

    const target = yield* pickTarget(request);
    if (!target) return yield* queued("no worker is free");

    const { workerType, workerId } = target;
    const assigned = yield* tickets.assign(ticketId, { workerType, workerId }, at);
    yield* auditTicket(assigned, "assigned", COORDINATOR, { from: "open", at });

    if (target.slot) {
      const { slot } = target;
      const others = (yield* tickets.listByStatus(slot.statuses)).filter(
        (t) => slot.holds(t) && t.id !== ticketId,
      );
      // Past the cap: this ticket took the slot last, so it goes back. A claimed ticket is the
      // worker's now and stays; only `assigned` ones were ever at risk.
      if (others.length >= slot.limit) {
        const reason = "its worker filled up meanwhile";
        if (yield* giveBack(ticketId, workerId, reason)) return yield* queued(reason);
      }
    }

    if (target.kind === "sandbox") {
      const launcher = yield* WorkerLauncher;
      const provider = (yield* launcher.pool).find((entry) => entry.workerType === workerType);
      const mcpToken = yield* issueSandboxToken(workerId, sandboxTokenTtlSeconds(provider));
      const ticketTaskType = yield* taskTypeOf(assigned.taskTypeId);
      const failure = yield* launcher
        .launch({
          ticketId,
          workerType,
          workerId,
          mcpToken,
          ...(ticketTaskType && {
            taskType: { name: ticketTaskType.name, instructions: ticketTaskType.instructions },
          }),
        })
        .pipe(
          Effect.as(undefined),
          Effect.catchTag("LaunchFailed", (e) => Effect.succeed(e.message)),
        );
      if (failure !== undefined) {
        yield* revokeSandboxToken(mcpToken);
        const reason = `could not start ${workerId}: ${failure}`;
        if (yield* giveBack(ticketId, workerId, reason)) return yield* queued(reason);
      }
    }

    yield* assignedEvent(target.body, {
      workerType,
      workerId,
      personal: target.kind === "personal",
      kind: target.kind,
    });
    return { kind: "placed", ticket: assigned, workerId } satisfies Placement as Placement;
  });
