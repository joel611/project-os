import { Schema } from "effect";
import { Requester } from "./entities.ts";

/** The Google scope that lets the Email Digest read a mailbox, and nothing more. */
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** The mailbox choice that reads the whole inbox; any other value is a Gmail label id. */
export const EMAIL_LABEL_ALL = "all";

/** A Gmail label a person may limit the digest to. */
export const EmailLabel = Schema.Struct({ id: Schema.String, name: Schema.String });
export type EmailLabel = typeof EmailLabel.Type;

const Timestamp = Schema.String;

/** Where an email stands: waiting for a project, filed under one, or dropped by the person. */
export const EmailStatus = Schema.Literals(["unassigned", "assigned", "dismissed"]);
export type EmailStatus = typeof EmailStatus.Type;

/** Who filed an email: the classifier (at or above the confidence threshold) or the person. */
export const EmailAssignedBy = Schema.Literals(["classifier", "person"]);
export type EmailAssignedBy = typeof EmailAssignedBy.Type;

/**
 * An email from a person's mailbox, as kept for the Email Digest. `body` is redacted and only
 * kept while the email waits for a project; once its facts are in Project Memory it is empty.
 */
export const EmailItem = Schema.Struct({
  id: Schema.NonEmptyString,
  owner: Requester,
  /** Gmail's id for the message, unique per owner. */
  messageId: Schema.String,
  threadId: Schema.String,
  fromName: Schema.NullOr(Schema.String),
  fromAddress: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  receivedAt: Timestamp,
  status: EmailStatus,
  projectId: Schema.NullOr(Schema.String),
  assignedBy: Schema.NullOr(EmailAssignedBy),
  /** The classifier's best guess and how sure it was; null when it could not answer. */
  suggestedProjectId: Schema.NullOr(Schema.String),
  confidence: Schema.NullOr(Schema.Finite),
});
export type EmailItem = typeof EmailItem.Type;

/** `sourceMetadata` of a memory entry saved from an email. The body is redacted and cut. */
export const EmailDigestSource = Schema.Struct({
  source: Schema.Literal("email_digest"),
  from: Schema.String,
  subject: Schema.String,
  receivedAt: Timestamp,
  quote: Schema.String,
  assignedBy: EmailAssignedBy,
});
export type EmailDigestSource = typeof EmailDigestSource.Type;
export const isEmailDigestSource = Schema.is(EmailDigestSource);

/** `GET /me/email`: whether the person's mailbox is read, and the emails waiting for a project. */
export const MyEmail = Schema.Struct({
  /** Email indexing is set up on this Coordinator (Google client with the Gmail scope). */
  available: Schema.Boolean,
  enabled: Schema.Boolean,
  /** What is read: `all` (the inbox) or one Gmail label id; null until the person has chosen. */
  label: Schema.NullOr(Schema.String),
  /** The Gmail link is missing or lacks the read scope: `/connect google` again. */
  needsReconnect: Schema.Boolean,
  lastSyncAt: Schema.NullOr(Timestamp),
  /** Projects an email can be filed under: a member may not list projects, so they come here. */
  projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  unassigned: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      fromName: Schema.NullOr(Schema.String),
      fromAddress: Schema.String,
      subject: Schema.String,
      excerpt: Schema.String,
      receivedAt: Timestamp,
      suggestedProjectId: Schema.NullOr(Schema.String),
      confidence: Schema.NullOr(Schema.Finite),
    }),
  ),
});
export type MyEmail = typeof MyEmail.Type;

export const SetMyEmailEnabled = Schema.Struct({
  enabled: Schema.Boolean,
  /** Required to switch on: `all`, or a Gmail label id. Sent again, it changes the label. */
  label: Schema.optionalKey(Schema.NonEmptyString),
});
export const EmailLabels = Schema.Array(EmailLabel);
export const AssignEmail = Schema.Struct({
  /** A project id, or null to dismiss the email. */
  projectId: Schema.NullOr(Schema.NonEmptyString),
});
export type AssignEmail = typeof AssignEmail.Type;
