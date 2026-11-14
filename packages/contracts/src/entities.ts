import { Schema } from "effect";
import {
  Actor,
  ChannelType,
  MemoryEntryType,
  ProjectSourceType,
  TicketEventType,
  WorkerType,
} from "./enums.ts";
import { TicketStatus } from "./ticket-status.ts";

const Json = Schema.Unknown;
const Timestamp = Schema.String;
const Id = Schema.NonEmptyString;

/** Who asked for a Ticket, by their channel's own user id. */
export const Requester = Schema.Struct({ channelType: ChannelType, id: Schema.String });
export type Requester = typeof Requester.Type;

export const Ticket = Schema.Struct({
  id: Id,
  projectId: Id,
  status: TicketStatus,
  title: Schema.String,
  intent: Schema.NullOr(Schema.String),
  inputSummary: Schema.String,
  priority: Schema.NullOr(Schema.String),
  workerType: Schema.NullOr(WorkerType),
  workerId: Schema.NullOr(Schema.String),
  /** Null for Tickets made before it was recorded, and for ones no person asked for. */
  requester: Schema.NullOr(Requester),
  result: Json,
  error: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  assignedAt: Schema.NullOr(Timestamp),
  startedAt: Schema.NullOr(Timestamp),
  lastActivityAt: Timestamp,
  completedAt: Schema.NullOr(Timestamp),
  updatedAt: Timestamp,
});
export type Ticket = typeof Ticket.Type;

export const TicketEvent = Schema.Struct({
  id: Id,
  ticketId: Id,
  type: TicketEventType,
  actor: Actor,
  actorId: Schema.NullOr(Schema.String),
  body: Schema.String,
  payload: Json,
  createdAt: Timestamp,
});
export type TicketEvent = typeof TicketEvent.Type;

/** The channel thread a Ticket's conversation lives in. One thread per ticket, and back. */
export const TicketThread = Schema.Struct({
  ticketId: Id,
  channelType: ChannelType,
  /** Parent channel of the thread. */
  channelId: Schema.String,
  threadId: Schema.String,
  createdAt: Timestamp,
});
export type TicketThread = typeof TicketThread.Type;

export const MemoryEntry = Schema.Struct({
  id: Id,
  projectId: Id,
  ticketId: Schema.NullOr(Schema.String),
  type: MemoryEntryType,
  title: Schema.String,
  content: Schema.String,
  sourceMetadata: Json,
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
});
export type MemoryEntry = typeof MemoryEntry.Type;

/** A message a Channel Digest memory entry came from: who said what, when, and where. */
export const DigestSourceMessage = Schema.Struct({
  id: Schema.String,
  sender: Schema.String,
  senderId: Schema.String,
  sentAt: Timestamp,
  /** Set when it was said in a ticket thread. */
  threadId: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  /** The message text, cut at 500 characters. */
  quote: Schema.String,
});
export type DigestSourceMessage = typeof DigestSourceMessage.Type;

/**
 * `sourceMetadata` of a memory entry the Channel Digest saved: the messages that best show
 * where it came from, most relevant first, so "why do we...?" can be answered with who and when.
 */
export const ChannelDigestSource = Schema.Struct({
  source: Schema.Literal("channel_digest"),
  channelType: ChannelType,
  channelId: Schema.String,
  messages: Schema.Array(DigestSourceMessage),
});
export type ChannelDigestSource = typeof ChannelDigestSource.Type;
export const isChannelDigestSource = Schema.is(ChannelDigestSource);

/**
 * Something a person said in a project channel or one of its ticket threads, kept until the
 * Channel Digest has read it. Deleted once digested.
 */
export const ChannelMessage = Schema.Struct({
  id: Id,
  projectId: Id,
  channelType: ChannelType,
  channelId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  /** The channel's own message id; unique per channel type. */
  externalId: Schema.String,
  senderId: Schema.String,
  senderName: Schema.NullOr(Schema.String),
  content: Schema.String,
  /** Link that opens the message, when the channel has one. */
  url: Schema.NullOr(Schema.String),
  sentAt: Timestamp,
});
export type ChannelMessage = typeof ChannelMessage.Type;

export const Project = Schema.Struct({
  id: Id,
  orgId: Id,
  name: Schema.String,
  slug: Schema.NullOr(Schema.String),
  customInstructions: Schema.String,
  /** FK to a ProjectSource (usually Discord). */
  defaultResponseChannelId: Schema.NullOr(Schema.String),
  /** Channel Digest: save decisions from the project's channel chat to memory. */
  channelDigest: Schema.Boolean,
  /** Channel Digest: also post in the channel what it saved. */
  channelDigestNotify: Schema.Boolean,
  status: Schema.Literals(["active", "archived", "deleted"]),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = typeof Project.Type;

export const SourceDirection = Schema.Literals(["inbound", "outbound", "both"]);
export type SourceDirection = typeof SourceDirection.Type;

export const ProjectSource = Schema.Struct({
  id: Id,
  projectId: Id,
  type: ProjectSourceType,
  externalId: Schema.String,
  name: Schema.String,
  /** Short handle, unique within the project, that says what the source is for (e.g. `design-docs`). */
  alias: Schema.String,
  /** Optional extra context for agents and people: what is in it, when to use it. */
  description: Schema.NullOr(Schema.String),
  direction: SourceDirection,
  isDefaultResponse: Schema.Boolean,
  config: Json,
  status: Schema.Literals(["active", "disabled"]),
  connectedBy: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectSource = typeof ProjectSource.Type;

export const Worker = Schema.Struct({
  id: Id,
  workerType: WorkerType,
  /**
   * Personal workers (a device someone registered with /register-worker) serve only their
   * owner's tickets. Null on shared workers (devices an admin registered, sandbox sessions).
   */
  ownerChannelType: Schema.NullOr(ChannelType),
  ownerId: Schema.NullOr(Schema.String),
  /**
   * Registered with a one-time /register-worker code, so it holds a bearer secret it must
   * send. False on sandbox sessions, which the Coordinator starts itself.
   */
  registered: Schema.Boolean,
  /** Label given to the device at registration (defaults to its hostname). */
  name: Schema.NullOr(Schema.String),
  currentTicketId: Schema.NullOr(Schema.String),
  lastSeenAt: Timestamp,
  createdAt: Timestamp,
});
export type Worker = typeof Worker.Type;

export const WorkerStatus = Schema.Literals(["online", "offline"]);
export type WorkerStatus = typeof WorkerStatus.Type;
