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
      requestId: `ticket-completed:${ticket.id}`,
      prompt: [
        `Compose a concise reply to the customer for the completed ticket "${ticket.title}".`,
        `Result: ${JSON.stringify(ticket.result)}`,
        ...events.map((e) => `[${e.type}] ${e.body}`),
      ].join("\n"),
    });
    yield* gateway.send({ ...destination, content });
    return true;
  });

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
      ticket.status === "completed" ? onTicketCompleted({ ticketId: ticket.id }) : Effect.void,
    ),
  );
