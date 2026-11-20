import { Schema } from "effect";
import { Ticket } from "./entities.ts";
import { ChannelType } from "./enums.ts";
import { PermissionMap, Role } from "./permissions.ts";

/**
 * Who is signed in to the dashboard (`GET /me`). An `admin` sees everything; a `member` sees only
 * the Tickets they are involved in. `permissions` is what the role is granted, so the dashboard
 * can hide what would only 403.
 * `person` is the channel identity linked to this sign-in, when there is one: always for a
 * member, and for an operator whose Google account is also linked from a channel.
 */
export const Viewer = Schema.Struct({
  role: Role,
  permissions: PermissionMap,
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
