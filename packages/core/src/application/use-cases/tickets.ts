import type { Actor, TicketEventType } from "@project-os/contracts";
import { Effect } from "effect";
import {
  type TicketStatus,
  type WorkerType,
  WorkerNotFound,
  workerLabel,
} from "../../domain/index.ts";
import { Clock, IdGenerator, TicketRepository, WorkerRepository } from "../ports/index.ts";
import { type AuditActor, auditTicket } from "./audit.ts";

export const nowIso = Effect.gen(function* () {
  const clock = yield* Clock;
  return (yield* clock.now).toISOString();
});

export const listAssigned = (input: {
  readonly workerId: string;
  readonly workerType?: WorkerType;
}) => Effect.flatMap(TicketRepository, (repo) => repo.listAssigned(input.workerId));

export const getTicket = (input: { readonly ticketId: string; readonly eventLimit?: number }) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const ticket = yield* repo.get(input.ticketId);
    const events = yield* repo.listEvents(input.ticketId, input.eventLimit);
    return { ticket, events };
  });

/** Named `…UseCase` to avoid clashing with the domain function `claimTicket`. */
export const claimTicketUseCase = (input: {
  readonly ticketId: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const at = yield* nowIso;
    const claimed = yield* repo.claim(input.ticketId, input.workerId, at);
    yield* auditTicket(claimed, "claimed", { type: "worker", id: input.workerId });
    return claimed;
  });

export const appendEvent = (input: {
  readonly ticketId: string;
  readonly type: TicketEventType;
  readonly actor: Actor;
  readonly actorId?: string;
  readonly body: string;
  readonly payload?: unknown;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    const createdAt = yield* nowIso;
    return yield* repo.appendEvent({
      id,
      ticketId: input.ticketId,
      type: input.type,
      actor: input.actor,
      actorId: input.actorId ?? null,
      body: input.body,
      payload: input.payload ?? null,
      createdAt,
    });
  });

export const updateStatus = (input: {
  readonly ticketId: string;
  readonly status: TicketStatus;
  readonly error?: string;
  /** Who changed it, for the audit log. Default: the ticket's worker. */
  readonly actor?: AuditActor;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const at = yield* nowIso;
    const from = (yield* repo.get(input.ticketId)).status;
    const updated = yield* repo.updateStatus(
      input.ticketId,
      input.status,
      at,
      input.error === undefined ? undefined : { error: input.error },
    );
    yield* auditTicket(
      updated,
      "status_changed",
      input.actor ??
        (updated.workerId === null
          ? { type: "coordinator" }
          : { type: "worker", id: updated.workerId }),
      { from },
    );
    return updated;
  });

/**
 * An Operator hands a ticket to a registered device (personal or shared), e.g. when its worker
 * is stuck. The device's Watcher picks it up on its next poll. Sandbox sessions are not targets:
 * the Coordinator starts those itself, one per ticket. The old worker loses access to the ticket
 * at once, since MCP tools only reach a ticket's current assignee.
 */
export const reassignTicketTo = (input: {
  readonly ticketId: string;
  readonly workerId: string;
  readonly by: AuditActor;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const target = yield* (yield* WorkerRepository).get(input.workerId);
    if (!target.registered) return yield* new WorkerNotFound({ workerId: input.workerId });
    const before = yield* repo.get(input.ticketId);
    const at = yield* nowIso;
    const reassigned = yield* repo.reassign(
      input.ticketId,
      { workerType: target.workerType, workerId: target.id },
      at,
    );
    const from = before.workerId === null ? "Assigned" : `Reassigned from ${before.workerId}`;
    yield* repo.appendEvent({
      id: yield* Effect.flatMap(IdGenerator, (g) => g.next),
      ticketId: input.ticketId,
      type: "assigned",
      actor: "coordinator",
      actorId: null,
      body: `${from} to ${workerLabel(target)} by ${input.by.name ?? "an operator"}`,
      payload: { workerType: target.workerType, workerId: target.id, from: before.workerId },
      createdAt: at,
    });
    yield* auditTicket(reassigned, "assigned", input.by, { from: before.status, at });
    return reassigned;
  });
