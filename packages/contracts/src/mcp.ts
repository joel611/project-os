import { Schema } from "effect";
import { MemoryEntry, Ticket, TicketEvent } from "./entities.ts";
import { Prompt, PromptKind } from "./prompts.ts";
import {
  Actor,
  ChannelType,
  ConnectionProvider,
  MemoryEntryType,
  ProjectSourceType,
  TicketEventType,
  WorkerType,
} from "./enums.ts";
import { TicketStatus } from "./ticket-status.ts";

const Id = Schema.NonEmptyString;

export const TicketListAssignedInput = Schema.Struct({
  workerId: Id,
  workerType: Schema.optionalKey(WorkerType),
});
export const TicketListAssignedOutput = Schema.Struct({ tickets: Schema.Array(Ticket) });

export const TicketClaimInput = Schema.Struct({ ticketId: Id, workerId: Id });
export const TicketClaimOutput = Schema.Struct({ ticket: Ticket });

export const TicketGetInput = Schema.Struct({
  ticketId: Id,
  eventLimit: Schema.optionalKey(Schema.Int),
});
export const TicketGetOutput = Schema.Struct({
  ticket: Ticket,
  events: Schema.Array(TicketEvent),
});

export const TicketAttachmentsInput = Schema.Struct({ ticketId: Id });
/** A file a person sent on the ticket. `url` is null when it can no longer be read. */
export const TicketAttachment = Schema.Struct({
  /** The ticket event (created or follow_up) whose message carried the file. */
  eventId: Schema.String,
  id: Schema.String,
  filename: Schema.String,
  contentType: Schema.NullOr(Schema.String),
  size: Schema.Number,
  /** Fresh download link, valid for about a day; plain GET, no auth header. */
  url: Schema.NullOr(Schema.String),
  /** Why `url` is null, e.g. the message was deleted. */
  error: Schema.optionalKey(Schema.String),
});
export const TicketAttachmentsOutput = Schema.Struct({
  attachments: Schema.Array(TicketAttachment),
});

export const TicketAppendEventInput = Schema.Struct({
  ticketId: Id,
  type: TicketEventType,
  actor: Actor,
  actorId: Schema.optionalKey(Schema.String),
  body: Schema.String,
  payload: Schema.optionalKey(Schema.Unknown),
});
export const TicketAppendEventOutput = Schema.Struct({ event: TicketEvent });

export const TicketUpdateStatusInput = Schema.Struct({
  ticketId: Id,
  status: TicketStatus,
  error: Schema.optionalKey(Schema.String),
});
export const TicketUpdateStatusOutput = Schema.Struct({ ticket: Ticket });

export const ProjectMemoryReadInput = Schema.Struct({
  projectId: Id,
  type: Schema.optionalKey(MemoryEntryType),
  limit: Schema.optionalKey(Schema.Int),
});
export const ProjectMemoryReadOutput = Schema.Struct({ entries: Schema.Array(MemoryEntry) });

export const ProjectMemoryWriteInput = Schema.Struct({
  projectId: Id,
  ticketId: Schema.optionalKey(Schema.String),
  type: MemoryEntryType,
  title: Schema.String,
  content: Schema.String,
  sourceMetadata: Schema.optionalKey(Schema.Unknown),
});
export const ProjectMemoryWriteOutput = Schema.Struct({ entry: MemoryEntry });

export const ProjectSourcesListInput = Schema.Struct({ projectId: Id });
/** What a Worker needs to find a source by what it is for: alias, description, and where it is. */
export const ProjectSourceSummary = Schema.Struct({
  alias: Schema.String,
  description: Schema.NullOr(Schema.String),
  type: ProjectSourceType,
  externalId: Schema.String,
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export const ProjectSourcesListOutput = Schema.Struct({
  sources: Schema.Array(ProjectSourceSummary),
});

export const WorkerHeartbeatInput = Schema.Struct({
  workerId: Id,
  workerType: WorkerType,
  ticketId: Schema.optionalKey(Schema.String),
});
export const WorkerHeartbeatOutput = Schema.Struct({ lastSeenAt: Schema.String });

export const UserTokenInput = Schema.Struct({ ticketId: Id, provider: ConnectionProvider });
export const UserTokenOutput = Schema.Struct({
  accessToken: Schema.String,
  /** ISO time the token stops working, when the provider says. */
  expiresAt: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  /** Whose token this is: the person behind the ticket's latest message. */
  person: Schema.Struct({
    channelType: ChannelType,
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
});

export const TicketAskInput = Schema.Struct({
  ticketId: Id,
  /** `approval`: Approve / Deny. `choice`: one of `options`. */
  kind: PromptKind,
  question: Schema.NonEmptyString,
  /** Required for `choice` (2 to 25, each at most 100 characters). Ignored for `approval`. */
  options: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
export const TicketAskOutput = Schema.Struct({ prompt: Prompt });

export const TicketGetPromptInput = Schema.Struct({ promptId: Id });
export const TicketGetPromptOutput = Schema.Struct({ prompt: Prompt });
