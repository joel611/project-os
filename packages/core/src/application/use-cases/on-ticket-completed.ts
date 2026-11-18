import { ticketBlockedSummary, ticketCompletedReply } from "@project-os/system-prompts";
import { Effect } from "effect";
import { AgentRuntime, ChannelGateway, TicketRepository } from "../ports/index.ts";
import type { TicketStatus } from "../../domain/index.ts";
import { ticketChannel } from "./prompts.ts";
import { appendEvent, updateStatus } from "./tickets.ts";

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

/** Discord rejects a message over 2000 characters; keep the Worker's own words under that. */
const REASON_MAX = 1500;

const clip = (text: string) =>
  text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1).trimEnd()}…`;

/**
 * The thread's notice that a ticket is blocked. The Coordinator shortens what the Worker said it
 * needs (`AgentRuntime`); if that fails or comes back empty, the Worker's own words are posted
 * as they are. With nothing from the Worker, the notice is generic.
 */
const blockedNotice = (ticketId: string) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const runtime = yield* AgentRuntime;
    const ticket = yield* repo.get(ticketId);
    const said = (yield* repo.listEvents(ticketId)).findLast(
      (e) => e.actor === "worker" && (e.type === "status_update" || e.type === "comment"),
    )?.body;
    const reason = said?.trim();
    if (!reason) {
      return `Ticket "${ticket.title}" is blocked and needs input before it can continue.`;
    }
    const summary = yield* runtime
      .respond({
        sessionId: `project:${ticket.projectId}`,
        // Per block: a resumed ticket can block again with a new reason.
        requestId: `ticket-blocked:${ticket.id}:${ticket.updatedAt}`,
        prompt: ticketBlockedSummary({ title: ticket.title, reason }),
      })
      .pipe(Effect.orElseSucceed(() => ""));
    return `Ticket "${ticket.title}" is blocked: ${clip(summary.trim() || reason)}\nReply here and I'll pick it back up.`;
  });

/**
 * Status change plus the completion hook. Every path that moves a ticket (HTTP, MCP) should
 * use this rather than `updateStatus`, so a `completed` ticket always gets its reply.
 */
export const updateStatusAndNotify = (input: {
  readonly ticketId: string;
  readonly status: TicketStatus;
  readonly error?: string;
  /** For `blocked`: what the Worker needs from the person, posted in the ticket's thread. */
  readonly reason?: string;
}) =>
  updateStatus(input).pipe(
    Effect.tap((ticket) =>
      ticket.status === "blocked" && input.reason?.trim()
        ? appendEvent({
            ticketId: ticket.id,
            type: "status_update",
            actor: "worker",
            ...(ticket.workerId === null ? {} : { actorId: ticket.workerId }),
            body: input.reason.trim(),
            payload: { kind: "blocked_reason" },
          })
        : Effect.void,
    ),
    Effect.tap((ticket) =>
      ticket.status === "completed"
        ? onTicketCompleted({ ticketId: ticket.id })
        : ticket.status === "failed"
          ? notifyTicket(
              ticket.id,
              `Ticket "${ticket.title}" failed${input.error ? `: ${input.error}` : "."}`,
            )
          : ticket.status === "blocked"
            ? Effect.flatMap(blockedNotice(ticket.id), (notice) => notifyTicket(ticket.id, notice))
            : Effect.void,
    ),
  );
