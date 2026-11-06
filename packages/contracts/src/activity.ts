import { Schema } from "effect";
import { ChannelType } from "./enums.ts";
import { Ticket, TicketEvent, Worker, WorkerStatus } from "./entities.ts";
import { InboundMessage } from "./inbound.ts";

/** Who asked for a ticket and where, read from its `created` event. */
export const TicketOrigin = Schema.Struct({
  channelType: ChannelType,
  sender: InboundMessage.fields.sender,
});
export type TicketOrigin = typeof TicketOrigin.Type;

export const ActivityTicket = Schema.Struct({
  ...Ticket.fields,
  origin: Schema.NullOr(TicketOrigin),
  /** Channel the Coordinator replies on (the project's default response source). */
  replyChannel: Schema.NullOr(ChannelType),
});
export type ActivityTicket = typeof ActivityTicket.Type;

export const ActivityWorker = Schema.Struct({ ...Worker.fields, status: WorkerStatus });
export type ActivityWorker = typeof ActivityWorker.Type;

/**
 * `GET /activity?since=`: what changed since a time, for the live system map. Pass the previous
 * response's `now` as the next `since`; the window is inclusive, so dedupe events by id.
 */
export const ActivityFeed = Schema.Struct({
  now: Schema.String,
  tickets: Schema.Array(ActivityTicket),
  events: Schema.Array(TicketEvent),
  workers: Schema.Array(ActivityWorker),
});
export type ActivityFeed = typeof ActivityFeed.Type;
