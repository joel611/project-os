import { Schema } from "effect";
import { ChannelType, WorkerType } from "./enums.ts";
import { TicketStatus } from "./ticket-status.ts";

/** What an audit entry is about. */
export const AUDIT_KINDS = [
  "inbound_event",
  "digest_event",
  "worker",
  "ticket",
  "connection",
  "runtime_error",
] as const;
export const AuditKind = Schema.Literals(AUDIT_KINDS);
export type AuditKind = typeof AuditKind.Type;

/** Who did it: a channel person, a Worker, or the Coordinator itself (sweeps, placement). */
export const AuditActorType = Schema.Literals(["person", "worker", "coordinator"]);
export type AuditActorType = typeof AuditActorType.Type;

/**
 * One row of the append-only audit log: something that arrived or changed, for the org-wide
 * Audit page and a project's Audit tab. `projectId` is null for things that belong to no
 * project (admin-channel and unlinked-channel messages, Workers), which show only org-wide.
 * `payload` is per kind; see the `*AuditPayload` schemas.
 */
export const AuditEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  at: Schema.String,
  kind: AuditKind,
  /** What happened, e.g. `received`, `digested`, `registered`, `went_offline`, `assigned`. */
  action: Schema.String,
  actorType: AuditActorType,
  actorId: Schema.NullOr(Schema.String),
  actorName: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(Schema.String),
  ticketId: Schema.NullOr(Schema.String),
  workerId: Schema.NullOr(Schema.String),
  /** One line a person can read. */
  summary: Schema.String,
  payload: Schema.Unknown,
});
export type AuditEntry = typeof AuditEntry.Type;

/** A page of entries, newest first. Pass `nextCursor` as `before` for the next page. */
export const AuditPage = Schema.Struct({
  entries: Schema.Array(AuditEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type AuditPage = typeof AuditPage.Type;

/** `inbound_event` / `received`: a message that reached the Coordinator, mentions removed. */
export const InboundAuditPayload = Schema.Struct({
  channelType: ChannelType,
  channelId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  /** The channel's own message id. */
  externalId: Schema.String,
  content: Schema.String,
  mentionsBot: Schema.Boolean,
  attachmentCount: Schema.Finite,
  url: Schema.NullOr(Schema.String),
  /** True when it came in on the admin channel. */
  admin: Schema.optionalKey(Schema.Boolean),
});
export type InboundAuditPayload = typeof InboundAuditPayload.Type;

/** A classifier answer to one question: what it chose, how sure, and every option's odds. */
export const ClassifierAnswerPayload = Schema.Struct({
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
});
export type ClassifierAnswerPayload = typeof ClassifierAnswerPayload.Type;

/**
 * `inbound_event` / `classified` or `classify_failed`: what the decision model made of a
 * message, and what the Coordinator did with it. Only messages that passed every gate are
 * classified. `externalId` ties it to the message's `received` row.
 */
export const ClassifiedAuditPayload = Schema.Struct({
  channelType: ChannelType,
  externalId: Schema.String,
  /** The model that answered, as `provider/model`, when it reported one. */
  model: Schema.NullOr(Schema.String),
  /** Absent when the classifier call failed. */
  intent: Schema.optionalKey(ClassifierAnswerPayload),
  executor: Schema.optionalKey(ClassifierAnswerPayload),
  /** The confidence the intent needed; below it the Coordinator asks to clarify. */
  threshold: Schema.Finite,
  /** The `InboundOutcome` kind, or `error` when handling failed. */
  outcome: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
export type ClassifiedAuditPayload = typeof ClassifiedAuditPayload.Type;

/** `digest_event` / `digested` or `failed`: one Channel Digest run over a project's chat. */
export const DigestAuditPayload = Schema.Struct({
  messages: Schema.Finite,
  /** Titles of the Project Memory entries the run saved. */
  saved: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type DigestAuditPayload = typeof DigestAuditPayload.Type;

/** `worker` rows: the Worker as it was. */
export const WorkerAuditPayload = Schema.Struct({
  workerType: WorkerType,
  name: Schema.NullOr(Schema.String),
  shared: Schema.optionalKey(Schema.Boolean),
  lastSeenAt: Schema.optionalKey(Schema.String),
});
export type WorkerAuditPayload = typeof WorkerAuditPayload.Type;

/** `ticket` rows: the Ticket's state after the change. */
export const TicketAuditPayload = Schema.Struct({
  title: Schema.String,
  status: TicketStatus,
  from: Schema.optionalKey(TicketStatus),
  workerType: Schema.NullOr(WorkerType),
  workerId: Schema.NullOr(Schema.String),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reason: Schema.optionalKey(Schema.String),
});
export type TicketAuditPayload = typeof TicketAuditPayload.Type;

/** Where in the Coordinator an uncaught error surfaced. */
export const RuntimeErrorSource = Schema.Literals(["http", "health_sweep", "channel_digest"]);
export type RuntimeErrorSource = typeof RuntimeErrorSource.Type;

/**
 * `runtime_error` / `raised`: an error the Coordinator did not handle (a route that threw, or a
 * Cron job that failed). Message and stack are masked for secrets and clipped. `fingerprint` is
 * the same for the same error from the same place, so repeats can be grouped; the log keeps one
 * row per fingerprint per hour; repeats inside that hour are not logged.
 */
export const RuntimeErrorAuditPayload = Schema.Struct({
  source: RuntimeErrorSource,
  /** `METHOD /route/:pattern` for `http`, the job name otherwise. */
  where: Schema.String,
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
  fingerprint: Schema.String,
});
export type RuntimeErrorAuditPayload = typeof RuntimeErrorAuditPayload.Type;
