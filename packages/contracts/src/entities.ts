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

export const Project = Schema.Struct({
  id: Id,
  orgId: Id,
  name: Schema.String,
  slug: Schema.NullOr(Schema.String),
  customInstructions: Schema.String,
  /** FK to a ProjectSource (usually Discord). */
  defaultResponseChannelId: Schema.NullOr(Schema.String),
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
  currentTicketId: Schema.NullOr(Schema.String),
  lastSeenAt: Timestamp,
  createdAt: Timestamp,
});
export type Worker = typeof Worker.Type;

export const WorkerStatus = Schema.Literals(["online", "offline"]);
export type WorkerStatus = typeof WorkerStatus.Type;
