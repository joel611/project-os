import { ticketCompletedReply } from "@project-os/system-prompts";
import { Effect } from "effect";
import { AgentRuntime, ChannelGateway, TicketRepository } from "../ports/index.ts";
import type { TicketStatus } from "../../domain/index.ts";
import { ticketChannel } from "./prompts.ts";
import { updateStatus } from "./tickets.ts";

/**
 * Composes the curated reply via `AgentRuntime` and sends it to the ticket's thread, or to the
 * project's default response source when it has none. Returns false (nothing sent) if neither
 * exists.
 */
export const onTicketCompleted = (input: { readonly ticketId: string }) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const runtime = yield* AgentRuntime;
    const gateway = yield* ChannelGateway;

    const ticket = yield* tickets.get(input.ticketId);
    const events = yield* tickets.listEvents(ticket.id);
    // The ticket's own thread if it has one, else the project's default response source.
    const destination = yield* ticketChannel(ticket.id);
    if (!destination) return false;

    const content = yield* runtime.respond({
      sessionId: `project:${ticket.projectId}`,
      // Per run: a reopened ticket completes again and needs a reply of its own.
      requestId: `ticket-completed:${ticket.id}:${ticket.completedAt ?? ""}`,
      prompt: ticketCompletedReply({ title: ticket.title, result: ticket.result, events }),
    });
    yield* gateway.send({ ...destination, content });
    return true;
  });

/**
 * Tells the ticket's thread (or the project's default response source) something happened to
 * it. Plain text, no Pi turn: these are status notices, not replies. Best effort: a send that
 * fails must not undo the status change that caused it.
 */
export const notifyTicket = (ticketId: string, content: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const destination = yield* ticketChannel(ticketId);
    if (!destination) return false;
    yield* gateway.send({ ...destination, content });
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Status change plus the completion hook. Every path that moves a ticket (HTTP, MCP) should
 * use this rather than `updateStatus`, so a `completed` ticket always gets its reply.
 */
export const updateStatusAndNotify = (input: {
  readonly ticketId: string;
  readonly status: TicketStatus;
  readonly error?: string;
}) =>
  updateStatus(input).pipe(
    Effect.tap((ticket) =>
      ticket.status === "completed"
        ? onTicketCompleted({ ticketId: ticket.id })
        : ticket.status === "failed"
          ? notifyTicket(
              ticket.id,
              `Ticket "${ticket.title}" failed${input.error ? `: ${input.error}` : "."}`,
            )
          : ticket.status === "blocked"
            ? notifyTicket(
                ticket.id,
                `Ticket "${ticket.title}" is blocked and needs input before it can continue.`,
              )
            : Effect.void,
    ),
  );
