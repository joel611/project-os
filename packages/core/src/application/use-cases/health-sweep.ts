import type { TicketEvent } from "@project-os/contracts";
import { Effect } from "effect";
import { workerStatus, type Ticket } from "../../domain/index.ts";
import { Clock, IdGenerator, TicketRepository, WorkerRepository } from "../ports/index.ts";

/** Thresholds in milliseconds (docs/technical-architecture.md §5.5). */
export interface HealthThresholds {
  /** Worker `lastSeenAt` older than this → offline. */
  readonly workerStaleMs: number;
  /** `assigned` and unpicked for this long → flagged. */
  readonly unpickedMs: number;
  /** `in_progress` with no activity for this long → `follow_up` event. */
  readonly followUpMs: number;
  /** `in_progress` with no activity for this long → failed. */
  readonly inactivityFailMs: number;
}

export type HealthAction =
  | { readonly kind: "assignment_flagged"; readonly ticketId: string; readonly reason: string }
  | { readonly kind: "follow_up"; readonly ticketId: string }
  | { readonly kind: "failed"; readonly ticketId: string; readonly reason: string };

const KIND_FLAGGED = "health_assignment_flagged";
const KIND_FOLLOW_UP = "health_follow_up";

const payloadOf = (event: TicketEvent): { kind?: unknown; idleSince?: string } =>
  typeof event.payload === "object" && event.payload !== null ? event.payload : {};

/**
 * Coordinator health sweep (§5.5). Safe to run repeatedly: a ticket is flagged / followed up
 * at most once per stalled period. Returns the actions taken. Per-ticket repository errors
 * are dropped so one bad ticket cannot stop the sweep.
 *
 * Worker online/offline is derived from `lastSeenAt` (see `workerStatus`), never stored.
 * Reassignment and retry are not implemented: the ticket state machine has no
 * `assigned → assigned` or `in_progress → assigned` edge, so stalled assignments are
 * flagged for the admin and dead in-progress tickets are failed.
 */
export const healthSweep = (thresholds: HealthThresholds) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const workers = yield* WorkerRepository;
    const ids = yield* IdGenerator;
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const at = now.toISOString();

    const offlineWorkers = new Set(
      (yield* workers.list)
        .filter((w) => workerStatus(w, now, thresholds.workerStaleMs) === "offline")
        .map((w) => w.id),
    );
    const isOffline = (t: Ticket) => t.workerId !== null && offlineWorkers.has(t.workerId);
    const ageMs = (iso: string) => now.getTime() - Date.parse(iso);

    const systemEvent = (
      ticketId: string,
      type: "system" | "follow_up",
      body: string,
      payload: unknown,
    ) =>
      Effect.flatMap(ids.next, (id) =>
        tickets.appendEvent({
          id,
          ticketId,
          type,
          actor: "system",
          actorId: null,
          body,
          payload,
          createdAt: at,
        }),
      );

    const sweepAssigned = (t: Ticket) =>
      Effect.gen(function* () {
        const since = t.assignedAt ?? t.createdAt;
        const offline = isOffline(t);
        if (!offline && ageMs(since) < thresholds.unpickedMs) return [];
        const events = yield* tickets.listEvents(t.id);
        if (events.some((e) => payloadOf(e).kind === KIND_FLAGGED && e.createdAt >= since)) {
          return [];
        }
        const reason = offline ? "worker offline" : "not picked up in time";
        yield* systemEvent(
          t.id,
          "system",
          `Assignment stalled: ${reason}. Needs admin attention.`,
          {
            kind: KIND_FLAGGED,
            reason,
          },
        );
        return [{ kind: "assignment_flagged", ticketId: t.id, reason } as const];
      });

    const sweepInProgress = (t: Ticket) =>
      Effect.gen(function* () {
        const events = yield* tickets.listEvents(t.id);
        const last = events.at(-1);
        // Our own follow_up bumps lastActivityAt; look through it to the real last activity.
        const idleSince =
          last !== undefined &&
          payloadOf(last).kind === KIND_FOLLOW_UP &&
          last.createdAt === t.lastActivityAt
            ? payloadOf(last).idleSince
            : undefined;
        const followedUp = idleSince !== undefined;
        const idle = ageMs(idleSince ?? t.lastActivityAt);

        const offline = isOffline(t);
        if (offline || idle >= thresholds.inactivityFailMs) {
          const reason = offline ? "worker offline" : "no activity";
          const error = `Failed by health sweep: ${reason}`;
          yield* systemEvent(t.id, "system", error, { kind: "health_failed", reason });
          yield* tickets.updateStatus(t.id, "failed", at, { error });
          return [{ kind: "failed", ticketId: t.id, reason } as const];
        }
        if (idle >= thresholds.followUpMs && !followedUp) {
          yield* systemEvent(t.id, "follow_up", "Status?", {
            kind: KIND_FOLLOW_UP,
            idleSince: t.lastActivityAt,
          });
          return [{ kind: "follow_up", ticketId: t.id } as const];
        }
        return [];
      });

    const guarded =
      (rule: (t: Ticket) => Effect.Effect<ReadonlyArray<HealthAction>, unknown>) => (t: Ticket) =>
        rule(t).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<HealthAction>>([])));

    const assigned = yield* tickets.listByStatus(["assigned"]);
    const running = yield* tickets.listByStatus(["in_progress"]);
    const a = yield* Effect.forEach(assigned, guarded(sweepAssigned));
    const b = yield* Effect.forEach(running, guarded(sweepInProgress));
    return [...a.flat(), ...b.flat()];
  });
