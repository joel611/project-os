import type { Actor, TicketEventType } from "@project-os/contracts";
import { Effect } from "effect";
import type { TicketStatus, WorkerType } from "../../domain/index.ts";
import { Clock, IdGenerator, TicketRepository } from "../ports/index.ts";
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
