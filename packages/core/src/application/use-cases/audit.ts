import type {
  AuditActorType,
  AuditEntry,
  AuditKind,
  ClassifiedAuditPayload,
  DigestAuditPayload,
  InboundAuditPayload,
  InboundMessage,
  TicketAuditPayload,
  TicketStatus,
  Worker,
  WorkerAuditPayload,
} from "@project-os/contracts";
import { Effect } from "effect";
import type { InboundOutcome } from "./handle-inbound.ts";
import { isSharedDevice, type Ticket, workerLabel } from "../../domain/index.ts";
import {
  AuditLogRepository,
  Clock,
  IdGenerator,
  ProjectRepository,
  WorkerRepository,
  type AuditQuery,
  type IntentResult,
} from "../ports/index.ts";

/** Most entries one read returns, and the default page size. */
export const AUDIT_PAGE_LIMIT = 200;

/** How long entries are kept when `AUDIT_RETENTION_DAYS` is unset. */
export const DEFAULT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Keeps a summary to one line's worth. */
const clip = (text: string) => (text.length > 140 ? `${text.slice(0, 139)}…` : text);

/** Discord user, role and channel mentions plus @everyone/@here. */
const MENTION = /<(?:@[!&]?|#)\d+>|@everyone|@here/g;

export const stripMentions = (content: string): string =>
  content.replace(MENTION, " ").replace(/\s+/g, " ").trim();

export interface AuditActor {
  readonly type: AuditActorType;
  readonly id?: string | null;
  readonly name?: string | null;
}

export const COORDINATOR: AuditActor = { type: "coordinator" };

export interface AuditInput {
  readonly kind: AuditKind;
  readonly action: string;
  readonly actor: AuditActor;
  readonly summary: string;
  readonly payload: unknown;
  readonly projectId?: string | null;
  readonly ticketId?: string | null;
  readonly workerId?: string | null;
  /** Default: now. */
  readonly at?: string;
  /** See `AuditLogRepository.append`. */
  readonly dedupeKey?: string;
}

/** Appends one audit entry. Returns false when `dedupeKey` was already logged. */
export const audit = (input: AuditInput) =>
  Effect.gen(function* () {
    const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    const at = input.at ?? (yield* Effect.flatMap(Clock, (c) => c.now)).toISOString();
    const entry: AuditEntry = {
      id,
      at,
      kind: input.kind,
      action: input.action,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorName: input.actor.name ?? null,
      projectId: input.projectId ?? null,
      ticketId: input.ticketId ?? null,
      workerId: input.workerId ?? null,
      summary: input.summary,
      payload: input.payload,
    };
    return yield* (yield* AuditLogRepository).append(entry, input.dedupeKey);
  });

/**
 * Logs a message that reached the Coordinator: in a project's channel (`projectId`), or on the
 * admin channel or a channel no project links (null, shown only org-wide). A message delivered
 * twice is logged once.
 */
export const auditInbound = (
  message: InboundMessage,
  projectId: string | null,
  options?: { readonly admin?: boolean },
) => {
  const content = stripMentions(message.content);
  const attachmentCount = message.attachments?.length ?? 0;
  const payload: InboundAuditPayload = {
    channelType: message.channelType,
    channelId: message.channelId,
    threadId: message.threadId ?? null,
    externalId: message.externalId,
    content,
    mentionsBot: message.mentionsBot === true,
    attachmentCount,
    url: message.url ?? null,
    ...(options?.admin === true ? { admin: true } : {}),
  };
  // Adapters drop messages with neither text nor files.
  const preview = content || `${attachmentCount} attachment(s)`;
  return audit({
    kind: "inbound_event",
    action: "received",
    actor: { type: "person", id: message.sender.id, name: message.sender.name ?? null },
    projectId,
    summary: clip(preview),
    payload,
    at: message.receivedAt,
    dedupeKey: `inbound:${message.channelType}:${message.externalId}`,
  });
};

/** What can follow a classification: an `InboundOutcome` past every gate, or a failure. */
export type ClassifiedOutcome =
  | Exclude<InboundOutcome["kind"], "duplicate" | "unlinked" | "not_mentioned" | "admin_forbidden">
  | "error";

/** How a classified row's summary names what the Coordinator did next. */
const OUTCOME_LABEL: Readonly<Record<ClassifiedOutcome, string>> = {
  ticket_created: "ticket created",
  follow_up_added: "follow-up added",
  ticket_closed: "ticket closed",
  status_answered: "status answered",
  memory_saved: "memory saved",
  sidekick_answered: "Sidekick answered",
  admin_handled: "admin handled",
  clarification_sent: "asked to clarify",
  error: "failed",
};

/**
 * Logs what the decision model made of a message and what came of it, beside the message's
 * `received` row. `result` is absent when the classifier call itself failed (`error` says why).
 */
export const auditClassification = (input: {
  readonly message: InboundMessage;
  readonly projectId: string | null;
  readonly result?: IntentResult;
  readonly threshold: number;
  readonly outcome: ClassifiedOutcome;
  readonly ticketId?: string;
  readonly error?: string;
}) => {
  const { message, result } = input;
  const payload: ClassifiedAuditPayload = {
    channelType: message.channelType,
    externalId: message.externalId,
    model: result?.model ?? null,
    ...(result && {
      intent: {
        choice: result.intent,
        confidence: result.confidence,
        probabilities: result.probabilities ?? { [result.intent]: result.confidence },
      },
    }),
    ...(result?.executorAnswer && { executor: result.executorAnswer }),
    threshold: input.threshold,
    outcome: input.outcome,
    ...(input.error !== undefined && { error: input.error }),
  };
  const summary = result
    ? `${result.intent} ${Math.round(result.confidence * 100)}% → ${OUTCOME_LABEL[input.outcome]}`
    : `classifier failed: ${String(input.error)}`;
  return audit({
    kind: "inbound_event",
    action: result ? "classified" : "classify_failed",
    actor: { type: "person", id: message.sender.id, name: message.sender.name ?? null },
    projectId: input.projectId,
    ticketId: input.ticketId ?? null,
    summary: clip(summary),
    payload,
    dedupeKey: `classified:${message.channelType}:${message.externalId}`,
  });
};

/** Logs one Channel Digest run (or its failure) over a project's chat. */
export const auditDigest = (input: {
  readonly projectId: string;
  readonly messages: number;
  readonly saved: ReadonlyArray<string>;
  readonly error?: string;
}) => {
  const payload: DigestAuditPayload = {
    messages: input.messages,
    saved: [...input.saved],
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  return audit({
    kind: "digest_event",
    action: input.error === undefined ? "digested" : "failed",
    actor: COORDINATOR,
    projectId: input.projectId,
    summary:
      input.error === undefined
        ? `Read ${input.messages} message(s), saved ${input.saved.length} to Project Memory`
        : `Digest failed: ${input.error}`,
    payload,
  });
};

const WORKER_SUMMARY: Record<string, (label: string) => string> = {
  registered: (l) => `${l} registered`,
  removed: (l) => `${l} removed`,
  first_seen: (l) => `${l} came online for the first time`,
  back_online: (l) => `${l} is back online`,
  went_offline: (l) => `${l} went offline`,
};

/** Logs a Worker change: registered, removed, first seen, back online or went offline. */
export const auditWorker = (
  worker: Worker,
  action: "registered" | "removed" | "first_seen" | "back_online" | "went_offline",
  options?: { readonly actor?: AuditActor; readonly at?: string; readonly dedupeKey?: string },
) => {
  const payload: WorkerAuditPayload = {
    workerType: worker.workerType,
    name: worker.name,
    ...(isSharedDevice(worker) ? { shared: true } : {}),
    ...(action === "went_offline" ? { lastSeenAt: worker.lastSeenAt } : {}),
  };
  return audit({
    kind: "worker",
    action,
    actor: options?.actor ?? { type: "worker", id: worker.id, name: worker.name },
    workerId: worker.id,
    summary: WORKER_SUMMARY[action]!(workerLabel(worker)),
    payload,
    ...(options?.at === undefined ? {} : { at: options.at }),
    ...(options?.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey }),
  });
};

const TICKET_SUMMARY: Record<string, (t: Ticket) => string> = {
  created: () => "Ticket created",
  assigned: (t) => `Assigned to ${t.workerId}`,
  claimed: (t) => `Claimed by ${t.workerId}`,
  released: () => "Sent back to the queue",
  status_changed: (t) => `Status changed to ${t.status}`,
};

/** Logs a Ticket lifecycle change; `ticket` is its state after the change. */
export const auditTicket = (
  ticket: Ticket,
  action: "created" | "assigned" | "claimed" | "released" | "status_changed",
  actor: AuditActor,
  extra?: { readonly from?: TicketStatus; readonly reason?: string; readonly at?: string },
) => {
  const payload: TicketAuditPayload = {
    title: ticket.title,
    status: ticket.status,
    ...(extra?.from === undefined ? {} : { from: extra.from }),
    workerType: ticket.workerType,
    workerId: ticket.workerId,
    ...(ticket.error === null ? {} : { error: ticket.error }),
    ...(extra?.reason === undefined ? {} : { reason: extra.reason }),
  };
  return audit({
    kind: "ticket",
    action,
    actor,
    projectId: ticket.projectId,
    ticketId: ticket.id,
    workerId: ticket.workerId,
    summary: `${TICKET_SUMMARY[action]!(ticket)}${extra?.reason ? `: ${extra.reason}` : ""}`,
    payload,
    at: extra?.at ?? ticket.updatedAt,
  });
};

/** A page cursor is the log position, as a string; anything else reads from the start. */
const parseCursor = (cursor: string | undefined) => {
  if (cursor === undefined || !/^\d+$/.test(cursor)) return undefined;
  return Number(cursor);
};

export interface AuditRead {
  readonly kind?: AuditKind;
  readonly projectId?: string;
  readonly workerId?: string;
  /** `nextCursor` of the previous page. */
  readonly before?: string;
  readonly limit?: number;
}

const readPage = (query: Omit<AuditQuery, "before" | "limit"> & AuditRead) =>
  Effect.gen(function* () {
    const limit = Math.min(Math.max(1, query.limit ?? AUDIT_PAGE_LIMIT), AUDIT_PAGE_LIMIT);
    const before = parseCursor(query.before);
    const { entries, next } = yield* (yield* AuditLogRepository).list({
      limit,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.workerId === undefined ? {} : { workerId: query.workerId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(before === undefined ? {} : { before }),
    });
    return { entries, nextCursor: next === null ? null : String(next) };
  });

/** The org-wide feed, optionally narrowed to one project or kind. */
export const readAudit = (query: AuditRead) =>
  Effect.gen(function* () {
    if (query.projectId !== undefined) yield* (yield* ProjectRepository).get(query.projectId);
    return yield* readPage(query);
  });

/** One project's feed (its Audit tab). */
export const readProjectAudit = (projectId: string, query: Omit<AuditRead, "projectId">) =>
  readAudit({ ...query, projectId });

/** One Worker's feed (its detail page): registration, outages, and the Tickets it worked. */
export const readWorkerAudit = (
  workerId: string,
  query: Omit<AuditRead, "projectId" | "workerId">,
) =>
  Effect.gen(function* () {
    yield* (yield* WorkerRepository).get(workerId);
    return yield* readPage({ ...query, workerId });
  });

/** Drops entries older than the retention window. Returns how many. */
export const pruneAudit = (retentionMs: number) =>
  Effect.gen(function* () {
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    return yield* (yield* AuditLogRepository).removeBefore(cutoff);
  });
