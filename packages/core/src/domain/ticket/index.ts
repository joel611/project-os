import type { Ticket, TicketEvent, TicketStatus } from "@project-os/contracts";
import { Data, Effect } from "effect";

export type { Ticket, TicketEvent, TicketStatus };

export class TicketNotFound extends Data.TaggedError("TicketNotFound")<{
  readonly ticketId: string;
}> {}

export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly ticketId: string;
  readonly from: TicketStatus;
  readonly to: TicketStatus;
}> {}

/** Claim failed: ticket is not `assigned`, or is assigned to a different worker. */
export class ClaimConflict extends Data.TaggedError("ClaimConflict")<{
  readonly ticketId: string;
  readonly workerId: string;
  readonly status: TicketStatus;
  readonly assignedTo: string | null;
}> {}

export const TERMINAL_STATUSES: ReadonlyArray<TicketStatus> = ["completed", "failed", "cancelled"];

export const ACTIVE_STATUSES: ReadonlyArray<TicketStatus> = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
];

const TRANSITIONS: Readonly<Record<TicketStatus, ReadonlyArray<TicketStatus>>> = {
  open: ["assigned", "failed", "cancelled"],
  assigned: ["in_progress", "failed", "cancelled"],
  in_progress: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["in_progress", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const isTerminal = (status: TicketStatus): boolean => TERMINAL_STATUSES.includes(status);

export const canTransition = (from: TicketStatus, to: TicketStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const nextStatuses = (from: TicketStatus): ReadonlyArray<TicketStatus> => TRANSITIONS[from];

/** Move a ticket to `to`, stamping timestamps. `at` is an ISO string. */
export const transitionTicket = (
  ticket: Ticket,
  to: TicketStatus,
  at: string,
  extra?: { readonly result?: unknown; readonly error?: string | null },
): Effect.Effect<Ticket, InvalidTransition> =>
  canTransition(ticket.status, to)
    ? Effect.succeed({
        ...ticket,
        status: to,
        result: extra?.result !== undefined ? extra.result : ticket.result,
        error: extra?.error !== undefined ? extra.error : ticket.error,
        assignedAt: to === "assigned" ? at : ticket.assignedAt,
        startedAt: to === "in_progress" && ticket.startedAt === null ? at : ticket.startedAt,
        completedAt: isTerminal(to) ? at : ticket.completedAt,
        lastActivityAt: at,
        updatedAt: at,
      })
    : Effect.fail(new InvalidTransition({ ticketId: ticket.id, from: ticket.status, to }));

/** Assign an open ticket to a worker (open → assigned). */
export const assignTicket = (
  ticket: Ticket,
  worker: { readonly workerId: string; readonly workerType: NonNullable<Ticket["workerType"]> },
  at: string,
): Effect.Effect<Ticket, InvalidTransition> =>
  Effect.map(transitionTicket(ticket, "assigned", at), (t) => ({
    ...t,
    workerId: worker.workerId,
    workerType: worker.workerType,
  }));

/**
 * Claim: the atomic `assigned → in_progress` transition. Only the assigned worker may claim,
 * and only from `assigned`. Repositories must apply this atomically.
 */
export const claimTicket = (
  ticket: Ticket,
  workerId: string,
  at: string,
): Effect.Effect<Ticket, ClaimConflict> =>
  ticket.status === "assigned" && ticket.workerId === workerId
    ? Effect.succeed({
        ...ticket,
        status: "in_progress" as const,
        startedAt: at,
        lastActivityAt: at,
        updatedAt: at,
      })
    : Effect.fail(
        new ClaimConflict({
          ticketId: ticket.id,
          workerId,
          status: ticket.status,
          assignedTo: ticket.workerId,
        }),
      );
