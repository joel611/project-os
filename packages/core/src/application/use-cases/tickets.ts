import type { Actor, TicketEventType } from "@project-os/contracts";
import { Effect } from "effect";
import type { WorkerType } from "../../domain/index.ts";
import { Clock, IdGenerator, TicketRepository } from "../ports/index.ts";

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

/** A Worker's own log entry. It changes nothing else; see `ticket-lifecycle.ts` for what does. */
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
