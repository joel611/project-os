import { Schema } from "effect";
import { ChannelType } from "./enums.ts";
import { Role } from "./permissions.ts";

/**
 * One person as the dashboard's Members page shows them (`GET /members`): the dashboard
 * (Google) sign-in, the channel identity, and the GitHub account, joined through the Google
 * account the person linked with `/connect google`. Any of the three can be missing.
 */
export const Member = Schema.Struct({
  /** Stable across reloads: the dashboard user id, else the channel identity. */
  key: Schema.String,
  name: Schema.String,
  /** The Google email: the dashboard sign-in's, else the linked account's when it could be read. */
  email: Schema.NullOr(Schema.String),
  /** The dashboard role: `admin` or `member`. A channel person without a sign-in is a member. */
  role: Role,
  /** On the Operator list, so allowed to sign in to the dashboard as themselves. */
  operator: Schema.Boolean,
  /** A dashboard user exists for this person. `lastSignInAt` is their newest session. */
  dashboard: Schema.NullOr(Schema.Struct({ lastSignInAt: Schema.NullOr(Schema.String) })),
  /** The channel identity that linked the same Google account. */
  channel: Schema.NullOr(
    Schema.Struct({
      type: ChannelType,
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
    }),
  ),
  googleLinked: Schema.Boolean,
  /** `login` is null when GitHub could not be asked (offline, revoked token). */
  github: Schema.NullOr(Schema.Struct({ login: Schema.NullOr(Schema.String) })),
});
export type Member = typeof Member.Type;

export const MemberList = Schema.Array(Member);
export type MemberList = typeof MemberList.Type;

/** `POST /members/:key/role`: an admin changes a dashboard user's role. */
export const SetMemberRole = Schema.Struct({ role: Role });
export type SetMemberRole = typeof SetMemberRole.Type;
