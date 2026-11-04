import { Schema } from "effect";
import { Actor, MemoryEntryType, TicketEventType, WorkerType } from "./enums.ts";
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
