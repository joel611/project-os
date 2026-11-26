import type { ChannelType, ProjectSourceType } from "@project-os/contracts";
import { Effect } from "effect";
import { ProjectSourceRepository, TicketRepository } from "../ports/index.ts";

/** Channel adapters speak `ChannelType`; project sources are typed more finely. */
export const CHANNEL_SOURCE_TYPES = {
  discord: "discord_channel",
  email: "email_address",
} as const satisfies Partial<Record<ChannelType, ProjectSourceType>>;

const SOURCE_CHANNEL_TYPES: Partial<Record<ProjectSourceType, ChannelType>> = Object.fromEntries(
  Object.entries(CHANNEL_SOURCE_TYPES).map(([channel, source]) => [source, channel]),
);

export const sourceTypeFor = (channel: ChannelType): ProjectSourceType | undefined =>
  (CHANNEL_SOURCE_TYPES as Partial<Record<ChannelType, ProjectSourceType>>)[channel];

export const channelTypeFor = (source: ProjectSourceType): ChannelType | undefined =>
  SOURCE_CHANNEL_TYPES[source];

/** Channels whose adapter can open a thread on a message, so each Ticket gets its own. */
export const supportsThreads = (channel: ChannelType): boolean => channel === "discord";

/** Channels whose adapter can react to a message, so the Coordinator can acknowledge it. */
export const supportsReactions = (channel: ChannelType): boolean => channel === "discord";

export interface PromptTarget {
  readonly channelType: ChannelType;
  readonly channelId: string;
  readonly threadId?: string;
}

/**
 * Where a ticket's conversation happens: its own thread, else the project's default response
 * source. `undefined` when it has neither.
 */
export const ticketChannel = (ticketId: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const sources = yield* ProjectSourceRepository;
    const ticket = yield* tickets.get(ticketId);
    const thread = yield* tickets.findThread(ticket.id);
    if (thread) {
      return {
        channelType: thread.channelType,
        channelId: thread.channelId,
        threadId: thread.threadId,
      } satisfies PromptTarget as PromptTarget;
    }
    const source = (yield* sources.listByProject(ticket.projectId)).find(
      (s) => s.isDefaultResponse && s.status === "active",
    );
    const channelType = source && channelTypeFor(source.type);
    return source && channelType
      ? ({ channelType, channelId: source.externalId } satisfies PromptTarget as PromptTarget)
      : undefined;
  });
