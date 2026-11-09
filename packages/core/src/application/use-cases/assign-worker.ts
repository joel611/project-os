import type { WorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { isSharedDevice, workerLabel, workerStatus } from "../../domain/index.ts";
import {
  Clock,
  IdGenerator,
  type Person,
  TicketRepository,
  WorkerLauncher,
  WorkerRepository,
} from "../ports/index.ts";
import { issueSandboxToken, onlinePersonalWorker } from "./personal-workers.ts";
import { pickSandboxProvider, sandboxTokenTtlSeconds, sandboxWorkerId } from "./sandbox-pool.ts";

/** Who takes a ticket, and how the `assigned` event names them. */
export interface WorkerPick {
  readonly workerType: WorkerType;
  readonly workerId: string;
  readonly body: string;
  readonly kind: "personal" | "shared" | "sandbox";
}

/** How new tickets find a worker. */
export interface WorkerRouting {
  /** A registered device counts as online if it heartbeat within this window. */
  readonly workerStaleMs: number;
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

/**
 * The online shared device (registered by an admin) holding the fewest tickets, if one is
 * under `sharedWorkerMaxTickets`. A full device leaves the ticket to the next option instead
 * of queuing it behind its others.
 */
export const freeSharedDevice = (routing: WorkerRouting) =>
  Effect.gen(function* () {
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const online = (yield* (yield* WorkerRepository).list).filter(
      (w) => isSharedDevice(w) && workerStatus(w, now, routing.workerStaleMs) === "online",
    );
    if (online.length === 0) return undefined;
    const held = yield* (yield* TicketRepository).listByStatus(["assigned", "in_progress"]);
    const load = (id: string) => held.filter((t) => t.workerId === id).length;
    const max = routing.sharedWorkerMaxTickets ?? 1;
    return online
      .filter((w) => load(w.id) < max)
      .sort((a, b) => load(a.id) - load(b.id) || b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  });

/**
 * Picks who works `requester`'s new ticket: their own online device, else a free shared
 * device, else the first sandbox provider in the pool with room. Undefined when none can
 * take it: the ticket waits, queued, until one can.
 */
export const pickWorker = (requester: Person, ticketId: string, routing: WorkerRouting) =>
  Effect.gen(function* () {
    const personal = yield* onlinePersonalWorker(requester, routing.workerStaleMs);
    if (personal) {
      return {
        workerType: personal.workerType,
        workerId: personal.id,
        body: `Assigned to the requester's own worker ${workerLabel(personal)}`,
        kind: "personal",
      } satisfies WorkerPick as WorkerPick;
    }
    const shared = yield* freeSharedDevice(routing);
    if (shared) {
      return {
        workerType: shared.workerType,
        workerId: shared.id,
        body: `Assigned to the shared worker ${workerLabel(shared)}`,
        kind: "shared",
      } satisfies WorkerPick as WorkerPick;
    }
    const sandbox = yield* pickSandboxProvider;
    if (sandbox) {
      // A sandbox session is a fresh worker per ticket, so it gets its own id.
      const workerId = sandboxWorkerId(sandbox.workerType, ticketId);
      return {
        workerType: sandbox.workerType,
        workerId,
        body: `Assigned to ${workerId}`,
        kind: "sandbox",
      } satisfies WorkerPick as WorkerPick;
    }
    return undefined;
  });

/**
 * Assigns an `open` ticket to `pick` and logs the `assigned` event. A sandbox pick also gets its
 * session launched, with an MCP token that acts as its worker id only.
 */
export const assignToWorker = (ticketId: string, pick: WorkerPick, at: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const ids = yield* IdGenerator;
    const { workerType, workerId } = pick;
    const assigned = yield* tickets.assign(ticketId, { workerType, workerId }, at);
    yield* tickets.appendEvent({
      id: yield* ids.next,
      ticketId,
      type: "assigned",
      actor: "coordinator",
      actorId: null,
      body: pick.body,
      payload: { workerType, workerId, personal: pick.kind === "personal", kind: pick.kind },
      createdAt: at,
    });
    if (pick.kind === "sandbox") {
      const launcher = yield* WorkerLauncher;
      const provider = (yield* launcher.pool).find((entry) => entry.workerType === workerType);
      const mcpToken = yield* issueSandboxToken(workerId, sandboxTokenTtlSeconds(provider));
      yield* launcher.launch({ ticketId, workerType, workerId, mcpToken });
    }
    return assigned;
  });
