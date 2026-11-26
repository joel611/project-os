/**
 * The Ticket lifecycle. Tell it what happened to a Ticket and who did it, and it owns what
 * follows: the state change (the domain's transition rules still decide what is allowed), the
 * TicketEvent history, the audit row and the notice or reply in the Ticket's thread. Callers
 * decide that something happened; they never write those consequences themselves.
 *
 * Not here: a Worker's own log entries (`appendEvent`), which have no consequences, and
 * deciding where a Ticket runs (Placement, which records its moves here).
 */
import type {
  Actor,
  InboundMessage,
  Prompt,
  PromptAnswer,
  ReplyInstruction,
  TicketEventType,
  WorkerType,
} from "@project-os/contracts";
import { ticketBlockedSummary, ticketCompletedReply } from "@project-os/system-prompts";
import { Effect } from "effect";
import { type Ticket, type TicketStatus, WorkerNotFound, workerLabel } from "../../domain/index.ts";
import {
  AgentRuntime,
  ChannelGateway,
  IdGenerator,
  TicketRepository,
  WorkerRepository,
} from "../ports/index.ts";
import {
  type AttachmentStorageConfig,
  attachmentsPayload,
  storeAttachments,
} from "./attachments.ts";
import { type AuditActor, auditTicket } from "./audit.ts";
import { type PromptTarget, ticketChannel } from "./channels.ts";
import { actingAs, requesterOf, sharedUseClause } from "./connections.ts";
import { nowIso } from "./tickets.ts";

/** Payload `kind` of the system event that marks a ticket as waiting for a worker. */
export const QUEUED_EVENT_KIND = "queued";
/** Payload `kind` of the event that flags an assignment nobody picked up. */
export const STALLED_EVENT_KIND = "health_assignment_flagged";
/** Payload `kind` of the event that asks a quiet Worker how it is going. */
export const STATUS_ASKED_EVENT_KIND = "health_follow_up";

export const QUEUED_MESSAGE =
  "No worker is free for this right now, so it's queued. It starts as soon as one has room.";
export const TICKET_REOPENED_MESSAGE = "I reopened this ticket. A worker will pick it up again.";
export const TICKET_RESUMED_MESSAGE = "Picking this back up. A worker will carry on with it.";

/** What the thread is told when a follow-up reopens a ticket (or resumes a blocked one). */
export const reopenedMessage = (from: TicketStatus, queued: boolean) => {
  const lead = from === "blocked" ? "Picking this back up." : "I reopened this ticket.";
  if (queued) return `${lead} ${QUEUED_MESSAGE}`;
  return from === "blocked" ? TICKET_RESUMED_MESSAGE : TICKET_REOPENED_MESSAGE;
};

export const sidekickFailedMessage = (reason: string) =>
  `Sorry, I couldn't look that up: ${reason}`;

/** Adds one entry to the ticket's history. */
const record = (event: {
  readonly ticketId: string;
  readonly type: TicketEventType;
  readonly actor: Actor;
  readonly actorId?: string | null | undefined;
  readonly body: string;
  readonly payload: unknown;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    return yield* tickets.appendEvent({ ...event, id, actorId: event.actorId ?? null });
  });

// Thread consequences.

/**
 * Tells the ticket's thread (or the project's default response source) something happened to
 * it. Plain text, no Pi turn: these are status notices, not replies. Best effort: a send that
 * fails must not undo the status change that caused it.
 */
const notifyThread = (ticketId: string, content: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const destination = yield* ticketChannel(ticketId);
    if (destination) yield* gateway.send({ ...destination, content });
  }).pipe(Effect.ignore);

/**
 * Composes the curated reply via `AgentRuntime` and sends it to the ticket's thread, or to the
 * project's default response source when it has none. Nothing is sent if neither exists.
 */
const replyCompleted = (ticketId: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const runtime = yield* AgentRuntime;
    const gateway = yield* ChannelGateway;

    const ticket = yield* tickets.get(ticketId);
    const events = yield* tickets.listEvents(ticket.id);
    const destination = yield* ticketChannel(ticket.id);
    if (!destination) return;

    const content = yield* runtime.respond({
      sessionId: `project:${ticket.projectId}`,
      // Per run: a reopened ticket completes again and needs a reply of its own.
      requestId: `ticket-completed:${ticket.id}:${ticket.completedAt}`,
      prompt: ticketCompletedReply({ title: ticket.title, result: ticket.result, events }),
    });
    yield* gateway.send({ ...destination, content });
  });

/** Discord rejects a message over 2000 characters; keep the Worker's own words under that. */
const REASON_MAX = 1500;

const clip = (text: string) =>
  text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1).trimEnd()}…`;

/**
 * The thread's notice that a ticket is blocked. The Coordinator shortens what the Worker said it
 * needs (`AgentRuntime`); if that fails or comes back empty, the Worker's own words are posted
 * as they are. With nothing from the Worker, the notice is generic.
 */
const blockedNotice = (ticketId: string) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const runtime = yield* AgentRuntime;
    const ticket = yield* repo.get(ticketId);
    const events = yield* repo.listEvents(ticketId);
    // Whose account the Worker acted with, so the person can trace a blocked access.
    const requester = requesterOf(events);
    const via = yield* sharedUseClause(ticketId);
    const actor = requester ? `\nActing as ${actingAs(requester)}${via}.` : "";
    const said = events.findLast(
      (e) => e.actor === "worker" && (e.type === "status_update" || e.type === "comment"),
    )?.body;
    const reason = said?.trim();
    if (!reason) {
      return `Ticket "${ticket.title}" is blocked and needs input before it can continue.${actor}`;
    }
    const summary = yield* runtime
      .respond({
        sessionId: `project:${ticket.projectId}`,
        // Per block: a resumed ticket can block again with a new reason.
        requestId: `ticket-blocked:${ticket.id}:${ticket.updatedAt}`,
        prompt: ticketBlockedSummary({ title: ticket.title, reason }),
      })
      .pipe(Effect.orElseSucceed(() => ""));
    return `Ticket "${ticket.title}" is blocked: ${clip(summary.trim() || reason)}${actor}\nReply here and I'll pick it back up.`;
  });

// Intake.

/**
 * A message became a new ticket, asked for by `by`. The files on it are copied into storage
 * unless `copyFiles` is false.
 */
export const openTicket = (input: {
  readonly ticket: Ticket;
  readonly message: InboundMessage;
  readonly copyFiles: boolean;
  readonly attachments?: AttachmentStorageConfig | undefined;
  readonly by: AuditActor;
}) =>
  Effect.gen(function* () {
    const { message } = input;
    const created = yield* (yield* TicketRepository).insert(input.ticket);
    yield* auditTicket(created, "created", input.by);
    const stored = input.copyFiles
      ? yield* storeAttachments(created.id, message, input.attachments)
      : new Set<string>();
    yield* record({
      ticketId: created.id,
      type: "created",
      actor: "coordinator",
      body: message.content,
      payload: {
        sender: message.sender,
        channelType: message.channelType,
        ...attachmentsPayload(message, stored),
      },
      createdAt: input.ticket.createdAt,
    });
    return created;
  });

/** The message's sender said more about a ticket. */
export const receiveFollowUp = (input: {
  readonly ticketId: string;
  readonly message: InboundMessage;
  readonly attachments?: AttachmentStorageConfig | undefined;
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticketId, message } = input;
    const stored = yield* storeAttachments(ticketId, message, input.attachments);
    yield* record({
      ticketId,
      type: "follow_up",
      actor: "coordinator",
      actorId: message.sender.id,
      body: message.content,
      payload: {
        sender: message.sender,
        channelType: message.channelType,
        ...attachmentsPayload(message, stored),
      },
      createdAt: input.at,
    });
  });

/**
 * A follow-up from `by` reopens `ticket` (its state before this). It still needs placing, and
 * the thread is told with `announceReopened` once Placement is done. Undefined when it can't be
 * reopened, e.g. another follow-up got there first.
 */
export const reopenTicket = (input: {
  readonly ticket: Ticket;
  readonly by: AuditActor;
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticket, at } = input;
    const reopened = yield* (yield* TicketRepository).reopen(ticket.id, at).pipe(
      Effect.map((t) => t as Ticket | undefined),
      Effect.catchTag("InvalidTransition", () => Effect.undefined),
    );
    if (!reopened) return undefined;
    yield* auditTicket(reopened, "reopened", input.by, { from: ticket.status, at });
    yield* record({
      ticketId: reopened.id,
      type: "system",
      actor: "coordinator",
      body:
        ticket.status === "blocked"
          ? "Resumed by a follow-up (was blocked)"
          : `Reopened by a follow-up (was ${ticket.status})`,
      payload: { kind: "reopened", from: ticket.status },
      createdAt: at,
    });
    return reopened;
  });

/**
 * Tells the thread a reopened ticket's outcome: at `replyTo` when answering a message there,
 * else wherever the ticket's conversation is (best effort).
 */
export const announceReopened = (input: {
  readonly ticketId: string;
  readonly from: TicketStatus;
  readonly queued: boolean;
  readonly replyTo?: PromptTarget | undefined;
}) => {
  const content = reopenedMessage(input.from, input.queued);
  const { replyTo } = input;
  return replyTo === undefined
    ? notifyThread(input.ticketId, content)
    : Effect.flatMap(ChannelGateway, (gateway) => gateway.send({ ...replyTo, content }));
};

// Prompts.

/** A Worker asked the people on its ticket a question, now posted. */
export const recordQuestionAsked = (ticketId: string, prompt: Prompt) =>
  record({
    ticketId,
    type: "comment",
    actor: "worker",
    body: `Asked: ${prompt.question} (${prompt.options.join(" / ")})`,
    payload: { promptId: prompt.id, kind: prompt.kind, options: prompt.options },
    createdAt: prompt.createdAt,
  });

/** Someone answered a ticket's prompt; the Worker reads it as a follow-up. */
export const recordQuestionAnswered = (input: {
  readonly ticketId: string;
  readonly prompt: Prompt;
  readonly answer: PromptAnswer;
  readonly label: string;
  readonly at: string;
}) => {
  const { prompt, answer, label } = input;
  return record({
    ticketId: input.ticketId,
    type: "follow_up",
    actor: "coordinator",
    actorId: answer.sender.id,
    body: `Answer to "${prompt.question}": ${label}`,
    payload: {
      promptId: prompt.id,
      kind: prompt.kind,
      choice: answer.choice,
      label,
      sender: answer.sender,
      channelType: answer.channelType,
    },
    createdAt: input.at,
  });
};

// Placement's moves.

/**
 * An `open` ticket was given to a worker. Its history entry waits for `recordPlacement`,
 * since Placement can still take the ticket back.
 */
export const assignTicket = (input: {
  readonly ticketId: string;
  readonly workerType: WorkerType;
  readonly workerId: string;
  readonly by: AuditActor;
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticketId, workerType, workerId, at } = input;
    const assigned = yield* (yield* TicketRepository).assign(
      ticketId,
      { workerType, workerId },
      at,
    );
    yield* auditTicket(assigned, "assigned", input.by, { from: "open", at });
    return assigned;
  });

/** The assignment held: `body` says who has the ticket. */
export const recordPlacement = (input: {
  readonly ticketId: string;
  readonly body: string;
  readonly payload: unknown;
  readonly at: string;
}) => record({ ...input, type: "assigned", actor: "coordinator", createdAt: input.at });

/** An assigned ticket was taken back from its worker before it claimed it. */
export const releaseTicket = (input: {
  readonly ticketId: string;
  readonly workerId: string;
  readonly reason: string;
  readonly by: AuditActor;
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticketId, workerId, reason, at } = input;
    const released = yield* (yield* TicketRepository).release(ticketId, workerId, at);
    yield* auditTicket(released, "released", input.by, { reason, at });
    return released;
  });

/** No worker had room: the ticket is now Queued. */
export const recordQueued = (input: {
  readonly ticketId: string;
  readonly reason: string;
  readonly at: string;
}) =>
  record({
    ticketId: input.ticketId,
    type: "system",
    actor: "coordinator",
    body: `Queued: ${input.reason}`,
    payload: { kind: QUEUED_EVENT_KIND },
    createdAt: input.at,
  });

// A Worker's, Operator's or Sidekick's moves.

/** A worker claimed its assigned ticket. Named `…UseCase` to avoid the domain's `claimTicket`. */
export const claimTicketUseCase = (input: {
  readonly ticketId: string;
  readonly workerId: string;
  readonly at?: string;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const at = input.at ?? (yield* nowIso);
    const claimed = yield* repo.claim(input.ticketId, input.workerId, at);
    yield* auditTicket(claimed, "claimed", { type: "worker", id: input.workerId }, { at });
    return claimed;
  });

/** The status change and its audit row, without the thread consequences. */
const transition = (input: {
  readonly ticketId: string;
  readonly status: TicketStatus;
  readonly by: AuditActor;
  readonly at: string;
  readonly error?: string | undefined;
  readonly auditReason?: string;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const { ticketId, status, at, error, auditReason } = input;
    const from = (yield* repo.get(ticketId)).status;
    const updated = yield* repo.updateStatus(
      ticketId,
      status,
      at,
      error === undefined ? undefined : { error },
    );
    yield* auditTicket(updated, "status_changed", input.by, {
      from,
      ...(auditReason === undefined ? {} : { reason: auditReason }),
      at,
    });
    return updated;
  });

/**
 * `by` (a Worker or an Operator) moved a ticket to `status`. The thread hears about it at once
 * (ADR-0001): `completed` gets the composed reply, `failed` and `blocked` a notice.
 */
export const changeTicketStatus = (input: {
  readonly ticketId: string;
  readonly status: TicketStatus;
  readonly by: AuditActor;
  readonly error?: string;
  /** For `blocked`: what the Worker needs from the person, posted in the ticket's thread. */
  readonly reason?: string;
}) =>
  Effect.gen(function* () {
    const ticket = yield* transition({
      ticketId: input.ticketId,
      status: input.status,
      by: input.by,
      at: yield* nowIso,
      error: input.error,
    });
    if (ticket.status === "completed") {
      yield* replyCompleted(ticket.id);
    } else if (ticket.status === "failed") {
      yield* notifyThread(
        ticket.id,
        `Ticket "${ticket.title}" failed${input.error ? `: ${input.error}` : "."}`,
      );
    } else if (ticket.status === "blocked") {
      const reason = input.reason?.trim();
      if (reason) {
        yield* record({
          ticketId: ticket.id,
          type: "status_update",
          actor: "worker",
          actorId: input.by.id,
          body: reason,
          payload: { kind: "blocked_reason" },
          createdAt: yield* nowIso,
        });
      }
      yield* notifyThread(ticket.id, yield* blockedNotice(ticket.id));
    }
    return ticket;
  });

/**
 * The Sidekick `by` answered a new ticket, or couldn't. That finishes the ticket, and its own
 * words are the reply at `replyTo`: no composed completion reply, no failure notice.
 */
export const finishSidekickTicket = (input: {
  readonly ticketId: string;
  readonly answer: { readonly ok: boolean; readonly text: string };
  readonly replyTo: Omit<ReplyInstruction, "content">;
  readonly by: AuditActor & { readonly id: string };
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticketId, answer, by } = input;
    yield* record({
      ticketId,
      type: answer.ok ? "result" : "error",
      actor: "worker",
      actorId: by.id,
      body: answer.text,
      payload: null,
      createdAt: input.at,
    });
    yield* transition({
      ticketId,
      status: answer.ok ? "completed" : "failed",
      by,
      at: yield* nowIso,
      error: answer.ok ? undefined : answer.text,
    });
    const gateway = yield* ChannelGateway;
    yield* gateway.send({
      ...input.replyTo,
      content: answer.ok ? answer.text : sidekickFailedMessage(answer.text),
    });
  });

/**
 * An Operator hands a ticket to a registered device (personal or shared), e.g. when its worker
 * is stuck. The device's Watcher picks it up on its next poll. Sandbox sessions are not targets:
 * the Coordinator starts those itself, one per ticket. The old worker loses access to the ticket
 * at once, since MCP tools only reach a ticket's current assignee.
 */
export const reassignTicketTo = (input: {
  readonly ticketId: string;
  readonly workerId: string;
  readonly by: AuditActor;
}) =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository;
    const workers = yield* WorkerRepository;
    const target = yield* workers.get(input.workerId);
    if (!target.registered) return yield* new WorkerNotFound({ workerId: input.workerId });
    const before = yield* repo.get(input.ticketId);
    const at = yield* nowIso;
    const reassigned = yield* repo.reassign(
      input.ticketId,
      { workerType: target.workerType, workerId: target.id },
      at,
    );
    const previous = before.workerId;
    const from =
      previous === null
        ? "Assigned"
        : `Reassigned from ${yield* workers.get(previous).pipe(
            Effect.map(workerLabel),
            Effect.orElseSucceed(() => previous),
          )}`;
    yield* record({
      ticketId: input.ticketId,
      type: "assigned",
      actor: "coordinator",
      body: `${from} to ${workerLabel(target)} by ${input.by.name ?? "an operator"}`,
      payload: { workerType: target.workerType, workerId: target.id, from: before.workerId },
      createdAt: at,
    });
    yield* auditTicket(reassigned, "assigned", input.by, { from: before.status, at });
    return reassigned;
  });

// The health sweep's findings.

/** Nobody picked an assigned ticket up. It stays assigned, flagged for an admin. */
export const flagStalledAssignment = (input: {
  readonly ticket: Ticket;
  readonly reason: string;
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticket, reason } = input;
    yield* record({
      ticketId: ticket.id,
      type: "system",
      actor: "system",
      body: `Assignment stalled: ${reason}. Needs admin attention.`,
      payload: { kind: STALLED_EVENT_KIND, reason },
      createdAt: input.at,
    });
    yield* notifyThread(
      ticket.id,
      `Ticket "${ticket.title}" hasn't been picked up yet (${reason}). It is flagged as stalled.`,
    );
  });

/** A Worker has gone quiet: ask it how it is going. */
export const askWorkerForStatus = (input: {
  readonly ticketId: string;
  readonly idleSince: string;
  readonly at: string;
}) =>
  record({
    ticketId: input.ticketId,
    type: "follow_up",
    actor: "system",
    body: "Status?",
    payload: { kind: STATUS_ASKED_EVENT_KIND, idleSince: input.idleSince },
    createdAt: input.at,
  });

/** The health sweep gave up on a dead ticket: it fails, and the thread is told why. */
export const failDeadTicket = (input: {
  readonly ticketId: string;
  readonly reason: string;
  readonly by: AuditActor;
  readonly at: string;
}) =>
  Effect.gen(function* () {
    const { ticketId, reason, at } = input;
    const error = `Failed by health sweep: ${reason}`;
    yield* record({
      ticketId,
      type: "system",
      actor: "system",
      body: error,
      payload: { kind: "health_failed", reason },
      createdAt: at,
    });
    const failed = yield* transition({
      ticketId,
      status: "failed",
      by: input.by,
      at,
      error,
      auditReason: reason,
    });
    yield* notifyThread(ticketId, `Ticket "${failed.title}" failed: ${reason}.`);
  });
