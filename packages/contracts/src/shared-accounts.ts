import { Schema } from "effect";
import { ChannelType, ConnectionProvider } from "./enums.ts";

/**
 * An account an admin linked for the team (`GET /shared-accounts`): a bot's GitHub, a shared
 * Google Drive. Tokens never leave the Coordinator; this is only what the dashboard shows.
 */
export const SharedAccount = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: ConnectionProvider,
  label: Schema.NonEmptyString,
  /** The provider's own name for it (GitHub login, Google email) when it could be read. */
  identity: Schema.NullOr(Schema.String),
  /** False until the admin finishes the provider's sign-in, or once the token stops working. */
  connected: Schema.Boolean,
  createdAt: Schema.String,
});
export type SharedAccount = typeof SharedAccount.Type;

/** Who acts with which shared account, because they have no personal link for that provider. */
export const SharedAssignment = Schema.Struct({
  channelType: ChannelType,
  personId: Schema.NonEmptyString,
  provider: ConnectionProvider,
  sharedAccountId: Schema.NonEmptyString,
  assignedAt: Schema.String,
});
export type SharedAssignment = typeof SharedAssignment.Type;

export const SharedAccountsView = Schema.Struct({
  accounts: Schema.Array(SharedAccount),
  assignments: Schema.Array(SharedAssignment),
});
export type SharedAccountsView = typeof SharedAccountsView.Type;

/** `POST /shared-accounts`: start a new shared account; the reply carries the link to open. */
export const CreateSharedAccount = Schema.Struct({
  provider: ConnectionProvider,
  label: Schema.NonEmptyString,
});
export type CreateSharedAccount = typeof CreateSharedAccount.Type;

/** Where an admin goes to run the provider's OAuth flow for a shared account. */
export const SharedAccountConnect = Schema.Struct({
  account: SharedAccount,
  connectUrl: Schema.String,
});
export type SharedAccountConnect = typeof SharedAccountConnect.Type;

/** `PUT /shared-accounts/assignments`: assign (or, with a null id, unassign) one person. */
export const AssignSharedAccount = Schema.Struct({
  channelType: ChannelType,
  personId: Schema.NonEmptyString,
  provider: ConnectionProvider,
  sharedAccountId: Schema.NullOr(Schema.NonEmptyString),
});
export type AssignSharedAccount = typeof AssignSharedAccount.Type;
