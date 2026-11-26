import type { TicketEvent } from "@project-os/contracts";
import { Effect } from "effect";
import { workerStatus, type Ticket } from "../../domain/index.ts";
import { Clock, TicketRepository, WorkerRepository } from "../ports/index.ts";
import {
  askWorkerForStatus,
  failDeadTicket,
  flagStalledAssignment,
  STALLED_EVENT_KIND,
  STATUS_ASKED_EVENT_KIND,
} from "./ticket-lifecycle.ts";
import { placeOrQueue } from "./placement.ts";
import { DEFAULT_RUN_RETENTION_MS, pruneRuns } from "./runs.ts";
import { auditWorker, COORDINATOR, DEFAULT_AUDIT_RETENTION_MS, pruneAudit } from "./audit.ts";

/** Thresholds in milliseconds (apps/site/reference/architecture.md §5.5). */
export interface HealthThresholds {
  /** Worker `lastSeenAt` older than this → offline. */
  readonly workerStaleMs: number;
  /** `assigned` and unpicked for this long → flagged. */
  readonly unpickedMs: number;
  /** `in_progress` with no activity for this long → `follow_up` event. */
  readonly followUpMs: number;
  /** `in_progress` with no activity for this long → failed. */
  readonly inactivityFailMs: number;
  /** Queued tickets are routed with this (see `PlacementRouting`). */
  readonly sharedWorkerMaxTickets?: number;
  /** Audit entries older than this are deleted. Default 90 days. */
  readonly auditRetentionMs?: number;
  /** Run transcripts older than this are deleted (their summaries stay). Default 30 days. */
  readonly runLogRetentionMs?: number;
}

export type HealthAction =
  | { readonly kind: "assigned"; readonly ticketId: string; readonly workerId: string }
  | { readonly kind: "assignment_flagged"; readonly ticketId: string; readonly reason: string }
  | { readonly kind: "follow_up"; readonly ticketId: string }
  | { readonly kind: "failed"; readonly ticketId: string; readonly reason: string };

/** How far past the stale threshold a silent worker is still logged as going offline. */
const OUTAGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const payloadOf = (event: TicketEvent): { kind?: unknown; idleSince?: string } =>
  typeof event.payload === "object" && event.payload !== null ? event.payload : {};

/**
 * Coordinator health sweep (§5.5). Safe to run repeatedly: a ticket is flagged / followed up
 * at most once per stalled period. Returns the actions taken. Per-ticket repository errors
 * are dropped so one bad ticket cannot stop the sweep.
 *
 * Queued tickets (`open`, no worker had room when they came in) are assigned, oldest first,
 * as soon as a worker can take them: the requester's own device, a free shared device, or a
 * sandbox from the pool.
 *
 * Worker online/offline is derived from `lastSeenAt` (see `workerStatus`), never stored.
 * The sweep never reassigns on its own: stalled assignments are flagged for the admin, who can
 * reassign from the dashboard (`reassignTicketTo`), and dead in-progress tickets are failed.
 */
export const healthSweep = (thresholds: HealthThresholds) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const workers = yield* WorkerRepository;
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const at = now.toISOString();

    yield* pruneAudit(thresholds.auditRetentionMs ?? DEFAULT_AUDIT_RETENTION_MS);
    yield* pruneRuns(thresholds.runLogRetentionMs ?? DEFAULT_RUN_RETENTION_MS).pipe(
      // Storage trouble must not stop the sweep; the next one tries again.
      Effect.catchCause(() => Effect.void),
    );

    const silent = (yield* workers.list).filter(
      (w) => workerStatus(w, now, thresholds.workerStaleMs) === "offline",
    );
    const offlineWorkers = new Set(silent.map((w) => w.id));
    // An outage is logged once: keyed by the last heartbeat before it. Only recent outages are
    // looked at, so long-gone workers (and ones that never heartbeat) cost nothing per sweep.
    yield* Effect.forEach(
      silent.filter((w) => {
        const silentMs = now.getTime() - Date.parse(w.lastSeenAt);
        return (
          Date.parse(w.lastSeenAt) > 0 && silentMs <= thresholds.workerStaleMs + OUTAGE_LOOKBACK_MS
        );
      }),
      (w) =>
        auditWorker(w, "went_offline", {
          actor: COORDINATOR,
          at,
          dedupeKey: `worker-offline:${w.id}:${w.lastSeenAt}`,
        }),
      { discard: true },
    );
    const isOffline = (t: Ticket) => t.workerId !== null && offlineWorkers.has(t.workerId);
    const ageMs = (iso: string) => now.getTime() - Date.parse(iso);

    const sweepQueued = (t: Ticket) =>
      Effect.gen(function* () {
        if (t.requester === null) return [];
        const placement = yield* placeOrQueue({
          ticketId: t.id,
          requester: t.requester,
          routing: thresholds,
          at,
          alreadyQueued: true,
        });
        if (placement.kind === "queued") return [];
        return [{ kind: "assigned", ticketId: t.id, workerId: placement.workerId } as const];
      });

    const sweepAssigned = (t: Ticket) =>
      Effect.gen(function* () {
        const since = t.assignedAt ?? t.createdAt;
        const offline = isOffline(t);
        if (!offline && ageMs(since) < thresholds.unpickedMs) return [];
        const events = yield* tickets.listEvents(t.id);
        if (events.some((e) => payloadOf(e).kind === STALLED_EVENT_KIND && e.createdAt >= since)) {
          return [];
        }
        const reason = offline ? "worker offline" : "not picked up in time";
        yield* flagStalledAssignment({ ticket: t, reason, at });
        return [{ kind: "assignment_flagged", ticketId: t.id, reason } as const];
      });

    const sweepInProgress = (t: Ticket) =>
      Effect.gen(function* () {
        const events = yield* tickets.listEvents(t.id);
        const last = events.at(-1);
        // Our own follow_up bumps lastActivityAt; look through it to the real last activity.
        const idleSince =
          last !== undefined &&
          payloadOf(last).kind === STATUS_ASKED_EVENT_KIND &&
          last.createdAt === t.lastActivityAt
            ? payloadOf(last).idleSince
            : undefined;
        const followedUp = idleSince !== undefined;
        const idle = ageMs(idleSince ?? t.lastActivityAt);

        const offline = isOffline(t);
        if (offline || idle >= thresholds.inactivityFailMs) {
          const reason = offline ? "worker offline" : "no activity";
          yield* failDeadTicket({ ticketId: t.id, reason, by: COORDINATOR, at });
          return [{ kind: "failed", ticketId: t.id, reason } as const];
        }
        if (idle >= thresholds.followUpMs && !followedUp) {
          yield* askWorkerForStatus({ ticketId: t.id, idleSince: t.lastActivityAt, at });
          return [{ kind: "follow_up", ticketId: t.id } as const];
        }
        return [];
      });

    const guarded =
      <R>(rule: (t: Ticket) => Effect.Effect<ReadonlyArray<HealthAction>, unknown, R>) =>
      (t: Ticket) =>
        rule(t).pipe(Effect.orElseSucceed((): ReadonlyArray<HealthAction> => []));

    // One at a time, oldest first: each assignment fills a slot the next pick must see.
    const queued = (yield* tickets.listByStatus(["open"]))
      .filter((t) => t.workerId === null)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const q = yield* Effect.forEach(queued, guarded(sweepQueued));
    const assigned = yield* tickets.listByStatus(["assigned"]);
    const running = yield* tickets.listByStatus(["in_progress"]);
    const a = yield* Effect.forEach(assigned, guarded(sweepAssigned));
    const b = yield* Effect.forEach(running, guarded(sweepInProgress));
    return [...q.flat(), ...a.flat(), ...b.flat()];
  });
