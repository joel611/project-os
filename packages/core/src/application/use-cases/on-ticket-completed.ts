import { Effect } from "effect";
import {
  AgentRuntime,
  ChannelGateway,
  ProjectSourceRepository,
  TicketRepository,
} from "../ports/index.ts";
import { channelTypeFor } from "./channels.ts";

/**
 * Composes the curated reply via `AgentRuntime` and sends it to the project's default
 * response source. Returns false (nothing sent) if the project has no usable default.
 */
export const onTicketCompleted = (input: { readonly ticketId: string }) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const sources = yield* ProjectSourceRepository;
    const runtime = yield* AgentRuntime;
    const gateway = yield* ChannelGateway;

    const ticket = yield* tickets.get(input.ticketId);
    const events = yield* tickets.listEvents(ticket.id);
    const target = (yield* sources.listByProject(ticket.projectId)).find(
      (s) => s.isDefaultResponse && s.status === "active",
    );
    const channelType = target && channelTypeFor(target.type);
    if (!target || !channelType) return false;

    const content = yield* runtime.respond({
      sessionId: `project:${ticket.projectId}`,
      prompt: [
        `Compose a concise reply to the customer for the completed ticket "${ticket.title}".`,
        `Result: ${JSON.stringify(ticket.result)}`,
        ...events.map((e) => `[${e.type}] ${e.body}`),
      ].join("\n"),
    });
    yield* gateway.send({ channelType, channelId: target.externalId, content });
    return true;
  });
