import { Schema } from "effect";
import { Ticket } from "./entities.ts";
import { ChannelType } from "./enums.ts";

/**
 * Who is signed in to the dashboard (`GET /me`). An `operator` sees everything; a `member` is a
 * channel person who linked their Google account and sees only the Tickets they are involved in.
 * `person` is the channel identity linked to this sign-in, when there is one: always for a
 * member, and for an operator whose Google account is also linked from a channel.
 */
export const Viewer = Schema.Struct({
  role: Schema.Literals(["operator", "member"]),
  name: Schema.String,
  person: Schema.NullOr(
    Schema.Struct({
      channelType: ChannelType,
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
    }),
  ),
});
export type Viewer = typeof Viewer.Type;

/** `GET /me/tickets`: the Tickets the viewer is involved in, newest activity first. */
export const MyTickets = Schema.Struct({
  tickets: Schema.Array(Ticket),
  /** Names of the Projects those Tickets belong to. */
  projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type MyTickets = typeof MyTickets.Type;
