import type { Requester } from "@project-os/contracts";
import { Effect } from "effect";
import { type Ticket, type TicketEvent, TicketNotFound } from "../../domain/ticket/index.ts";
import { ProjectRepository, TicketRepository } from "../ports/index.ts";
import { senderOf } from "./connections.ts";
import { listTicketAttachments } from "./attachments.ts";

const same = (a: Requester | null | undefined, b: Requester) =>
  a?.channelType === b.channelType && a.id === b.id;

/**
 * Whether `person` is involved in a Ticket: they asked for it, or wrote its first message or a
 * follow-up (in its thread, or by answering one of its prompts). The rule `listInvolving`
 * applies in the repository.
 */
export const involves = (
  ticket: Ticket,
  events: ReadonlyArray<TicketEvent>,
  person: Requester,
): boolean => same(ticket.requester, person) || events.some((e) => same(senderOf(e), person));

/** The Tickets `person` is involved in, with the names of their Projects (`GET /me/tickets`). */
export const listMyTickets = (person: Requester) =>
  Effect.gen(function* () {
    const tickets = yield* (yield* TicketRepository).listInvolving(person);
    const ids = new Set(tickets.map((t) => t.projectId));
    const projects = (yield* (yield* ProjectRepository).list)
      .filter((p) => ids.has(p.id))
      .map((p) => ({ id: p.id, name: p.name }));
    return { tickets, projects };
  });

/**
 * A Ticket and its events, for someone who may only see their own: `TicketNotFound` when they
 * aren't involved, so a member can't tell someone else's Ticket from a missing one.
 */
export const getMyTicket = (ticketId: string, person: Requester) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const ticket = yield* repo.get(ticketId);
    const events = yield* repo.listEvents(ticketId);
    if (!involves(ticket, events, person)) return yield* new TicketNotFound({ ticketId });
    return { ticket, events };
  });

/** A Ticket's files, for someone who may only see their own Tickets. */
export const listMyTicketAttachments = (ticketId: string, person: Requester) =>
  getMyTicket(ticketId, person).pipe(Effect.andThen(listTicketAttachments(ticketId)));
