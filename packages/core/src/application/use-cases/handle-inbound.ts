import { InboundMessage, type PromptAnswer, type ReplyInstruction } from "@project-os/contracts";
import { statusQuestion, ticketContext } from "@project-os/system-prompts";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  ACTIVE_STATUSES,
  canReopen,
  isTerminal,
  type Ticket,
  type TicketStatus,
} from "../../domain/index.ts";
import {
  AgentRuntime,
  ChannelGateway,
  IdGenerator,
  IntentClassifier,
  type IntentResult,
  KeyValueStore,
  type Person,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
  type TicketScope,
} from "../ports/index.ts";
import {
  type AttachmentStorageConfig,
  attachmentsPayload,
  storeAttachments,
} from "./attachments.ts";
import { sourceTypeFor, supportsReactions, supportsThreads } from "./channels.ts";
import { recordChannelMessage } from "./channel-digest.ts";
import { auditClassification, auditInbound, auditTicket, type ClassifiedOutcome } from "./audit.ts";
import { writeMemory } from "./memory.ts";
import { placeOrQueue, QUEUED_MESSAGE } from "./placement.ts";
import { notifyTicket } from "./on-ticket-completed.ts";
import {
  answerPrompt,
  askPrompt,
  getPrompt,
  PROMPT_TTL_SECONDS,
  type PromptAnswerConfig,
} from "./prompts.ts";
import { askSidekick, SIDEKICK_WORKER_ID } from "./sidekick.ts";
import { nowIso, updateStatus } from "./tickets.ts";

export interface HandleInboundConfig {
  /** Discord channel id of the dedicated admin channel. */
  readonly adminChannelId?: string;
  /**
   * Discord user ids allowed to act in the admin channel. Unset: no check. Empty: nobody.
   * Composition roots that set `adminChannelId` should always pass this.
   */
  readonly adminUserIds?: ReadonlyArray<string>;
  /** Below this the Coordinator asks a clarifying question. Default 0.5. */
  readonly confidenceThreshold?: number;
  readonly dedupeTtlSeconds?: number;
  /**
   * Ignore top-level Discord project channel messages that don't @mention the bot. Messages
   * in a thread, and in the admin channel, are handled either way.
   */
  readonly requireMention?: boolean;
  /**
   * The Channel Digest runs here: keep every message in a linked Discord project channel and
   * its threads, mentioned or not, for `digestChannels` to read later, in projects that have
   * `channelDigest` on.
   */
  readonly channelDigest?: boolean;
  /**
   * A registered device (personal or shared) counts as online if it heartbeat within this
   * window; only then does it get new tickets. Default 15 minutes.
   */
  readonly workerStaleMs?: number;
  /** See `PlacementRouting.sharedWorkerMaxTickets`. Default 1. */
  readonly sharedWorkerMaxTickets?: number;
  /** Which files are copied into storage at intake, and how big. Default: Discord's CDN, 100 MB. */
  readonly attachments?: AttachmentStorageConfig;
}

export type InboundOutcome =
  | { readonly kind: "duplicate" }
  | { readonly kind: "unlinked" }
  | { readonly kind: "not_mentioned" }
  | { readonly kind: "ticket_created"; readonly ticket: Ticket }
  | { readonly kind: "follow_up_added"; readonly ticketId: string }
  | { readonly kind: "ticket_reopened"; readonly ticket: Ticket }
  | { readonly kind: "chit_chat_ignored"; readonly ticketId: string }
  | { readonly kind: "scope_asked"; readonly ticketId: string; readonly promptId: string }
  | { readonly kind: "ticket_closed"; readonly ticketId: string }
  | { readonly kind: "status_answered" }
  | { readonly kind: "memory_saved" }
  | { readonly kind: "sidekick_answered"; readonly ticketId: string }
  | { readonly kind: "admin_handled" }
  | { readonly kind: "admin_forbidden" }
  | { readonly kind: "clarification_sent" };

const TITLE_MAX = 80;

/** Reaction put on a message the Coordinator takes in, so the sender knows it was seen. */
export const ACK_EMOJI = "👀";

export const THREAD_OPENED_MESSAGE =
  "I opened a ticket for this. Keep the conversation for it in this thread.";
export const TICKET_CLOSED_MESSAGE =
  "This ticket was cancelled. Post in the channel to start something new.";
export const TICKET_REOPENED_MESSAGE = "I reopened this ticket. A worker will pick it up again.";
export const TICKET_RESUMED_MESSAGE = "Picking this back up. A worker will carry on with it.";

/** What the thread is told when a follow-up reopens a ticket (or resumes a blocked one). */
export const reopenedMessage = (from: TicketStatus, queued: boolean) => {
  const lead = from === "blocked" ? "Picking this back up." : "I reopened this ticket.";
  if (queued) return `${lead} ${QUEUED_MESSAGE}`;
  return from === "blocked" ? TICKET_RESUMED_MESSAGE : TICKET_REOPENED_MESSAGE;
};

/**
 * Reopens `ticket` for a follow-up from `by` and places it again (`reopenTicket`). A blocked
 * ticket's Worker ended its session waiting for this, so it is resumed the same way. Undefined
 * when it can't be reopened, e.g. another follow-up got there first.
 */
const reopenForFollowUp = (ticket: Ticket, by: Person, routing: HandleInboundConfig, at: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const ids = yield* IdGenerator;
    const reopened = yield* tickets.reopen(ticket.id, at).pipe(
      Effect.map((t) => t as Ticket | undefined),
      Effect.catchTag("InvalidTransition", () => Effect.undefined),
    );
    if (!reopened) return undefined;
    yield* auditTicket(
      reopened,
      "reopened",
      { type: "person", id: by.id, name: by.name ?? null },
      { from: ticket.status, at },
    );
    yield* tickets.appendEvent({
      id: yield* ids.next,
      ticketId: reopened.id,
      type: "system",
      actor: "coordinator",
      actorId: null,
      body:
        ticket.status === "blocked"
          ? "Resumed by a follow-up (was blocked)"
          : `Reopened by a follow-up (was ${ticket.status})`,
      payload: { kind: "reopened", from: ticket.status },
      createdAt: at,
    });
    const placement = yield* placeOrQueue({
      ticketId: reopened.id,
      requester: reopened.requester ?? { channelType: by.channelType, id: by.id },
      routing,
      at,
    });
    return { ticket: placement.ticket, queued: placement.kind === "queued" };
  });

/** Asked when a message in a ticket's thread looks like different work. */
export const SCOPE_PROMPT_QUESTION =
  "This looks like a new request, not part of this ticket. Should I open a new ticket for it?";
export const NEW_TICKET_OPTION = "New ticket";
export const SAME_TICKET_OPTION = "Part of this ticket";
export const newTicketLinkMessage = (threadId: string) =>
  `I opened a new ticket for this: <#${threadId}>`;
export const newTicketThreadIntro = (fromThreadId: string, content: string) =>
  `New ticket from <#${fromThreadId}>:\n> ${content.replaceAll("\n", "\n> ")}`;

/**
 * A replay of a thread message once its scope prompt is answered: route it as `scope` says,
 * without asking again. `result` is the classifier's first answer, reused for a new ticket.
 */
export interface ScopeOverride {
  readonly scope: TicketScope;
  readonly result: IntentResult;
}

const scopeKey = (promptId: string) => `scope-ask:${promptId}`;

/** What a scope prompt remembers about the message it asked about. */
const ScopeAsk = Schema.fromJsonString(
  Schema.Struct({
    message: InboundMessage,
    result: Schema.Struct({
      intent: Schema.String,
      confidence: Schema.Finite,
      executor: Schema.optionalKey(Schema.Literals(["worker", "sidekick"])),
    }),
  }),
);
const decodeScopeAsk = Schema.decodeUnknownOption(ScopeAsk);

export const MEMORY_SAVED_MESSAGE = "Noted. I saved that to the project memory.";

export const sidekickFailedMessage = (reason: string) =>
  `Sorry, I couldn't look that up: ${reason}`;

/** What the classifier said about this message, kept for its `classified` audit row. */
interface Classification {
  readonly projectId: string | null;
  readonly result?: IntentResult;
  readonly error?: string;
}

/** Every failure here is a tagged `Error`; an interruption squashes to one too. */
const errorMessage = (cause: Cause.Cause<unknown>): string =>
  (Cause.squash(cause) as Error).message;

export const handleInbound = (
  message: InboundMessage,
  config: HandleInboundConfig,
  override?: ScopeOverride,
) => {
  const threshold = config.confidenceThreshold ?? 0.5;
  let classification: Classification | undefined;
  return Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const sources = yield* ProjectSourceRepository;
    const projects = yield* ProjectRepository;
    const tickets = yield* TicketRepository;
    const classifier = yield* IntentClassifier;
    const runtime = yield* AgentRuntime;
    const gateway = yield* ChannelGateway;
    const ids = yield* IdGenerator;

    const reply = (content: string): Effect.Effect<void> => {
      const instruction: ReplyInstruction = {
        channelType: message.channelType,
        channelId: message.channelId,
        ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        content,
      };
      return gateway.send(instruction);
    };
    const clarify = (): Effect.Effect<InboundOutcome> =>
      Effect.as(reply("Sorry, I didn't catch that. Could you tell me what you need?"), {
        kind: "clarification_sent",
      });

    /**
     * Gives a new ticket its own thread: the thread the message is in, or a new one opened on
     * the message. A failure to open one is logged and the ticket carries on without a thread.
     */
    const openTicketThread = (ticketId: string, at: string) =>
      Effect.gen(function* () {
        if (!supportsThreads(message.channelType)) return undefined;
        // Said in another ticket's thread: a new thread in the channel, since a message in a
        // thread can't start one of its own.
        const fromThread = override?.scope === "out_of_scope" ? message.threadId : undefined;
        const threadId =
          (fromThread === undefined ? message.threadId : undefined) ??
          (yield* gateway
            .createThread({
              channelType: message.channelType,
              channelId: message.channelId,
              ...(fromThread === undefined ? { messageId: message.externalId } : {}),
              name: message.content.slice(0, TITLE_MAX),
            })
            .pipe(
              Effect.map((created) => created.threadId),
              Effect.catch((err) =>
                Effect.as(
                  Effect.logWarning(`could not open a thread for ticket ${ticketId}`, err.message),
                  undefined,
                ),
              ),
            ));
        if (threadId === undefined) return undefined;
        yield* tickets.linkThread({
          ticketId,
          channelType: message.channelType,
          channelId: message.channelId,
          threadId,
          createdAt: at,
        });
        yield* gateway.send({
          channelType: message.channelType,
          channelId: message.channelId,
          threadId,
          content:
            fromThread === undefined
              ? THREAD_OPENED_MESSAGE
              : `${newTicketThreadIntro(fromThread, message.content)}\n\n${THREAD_OPENED_MESSAGE}`,
        });
        if (fromThread !== undefined) yield* reply(newTicketLinkMessage(threadId));
        return threadId;
      });

    /**
     * Reacts with 👀 once the message has passed every gate, before the (slow) classifier and
     * agent run. A failure (e.g. no Add Reactions permission) is logged and handling carries on.
     */
    const acknowledge = (): Effect.Effect<void> =>
      supportsReactions(message.channelType)
        ? gateway
            .react({
              channelType: message.channelType,
              channelId: message.channelId,
              ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
              messageId: message.externalId,
              emoji: ACK_EMOJI,
            })
            .pipe(
              Effect.catch((err) =>
                Effect.logWarning(`could not react to message ${message.externalId}`, err.message),
              ),
            )
        : Effect.void;

    const replyIn = (threadId: string | undefined, content: string) =>
      threadId === undefined
        ? reply(content)
        : gateway.send({
            channelType: message.channelType,
            channelId: message.channelId,
            threadId,
            content,
          });

    // A replay was taken in, logged and acknowledged the first time round.
    const replay = override !== undefined;
    const fresh =
      replay ||
      (yield* kv.setIfAbsent(`inbound:${message.channelType}:${message.externalId}`, "1", {
        ttlSeconds: config.dedupeTtlSeconds ?? 86_400,
      }));
    if (!fresh) return { kind: "duplicate" } satisfies InboundOutcome as InboundOutcome;

    const isAdminChannel =
      message.channelType === "discord" && message.channelId === config.adminChannelId;

    const sourceType = sourceTypeFor(message.channelType);
    const source =
      sourceType && !isAdminChannel
        ? yield* sources.findByExternal(sourceType, message.channelId)
        : undefined;

    // Everything that arrives is logged, even what is refused or ignored below. Admin-channel
    // and unlinked-channel messages belong to no project, so they show only org-wide.
    if (!replay) yield* auditInbound(message, source?.projectId ?? null, { admin: isAdminChannel });

    if (isAdminChannel && config.adminUserIds && !config.adminUserIds.includes(message.sender.id)) {
      yield* reply("Not authorized: you are not on the admin list.");
      return { kind: "admin_forbidden" } as InboundOutcome;
    }

    const classify = (projectContext: string, projectId: string | null, ticket?: string) =>
      classifier
        .classify({
          content: message.content,
          projectContext,
          ...(ticket === undefined ? {} : { ticketContext: ticket }),
        })
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              classification = { projectId, result };
            }),
          ),
          Effect.tapError((e) =>
            Effect.sync(() => {
              classification = { projectId, error: e.message };
            }),
          ),
        );
    const isConfident = (confidence: number) => confidence >= threshold;

    if (isAdminChannel) {
      yield* acknowledge();
      const result = yield* classify("", null);
      if (!isConfident(result.confidence) || result.intent !== "admin_command") {
        return yield* clarify();
      }
      const text = yield* runtime.respond({
        sessionId: `admin:${message.channelId}`,
        prompt: message.content,
        requestId: message.externalId,
      });
      yield* reply(text);
      return { kind: "admin_handled" } as InboundOutcome;
    }

    // Before the mention gate: the digest reads what people say among themselves too.
    if (!replay && source && config.channelDigest && message.channelType === "discord") {
      const target = yield* projects.get(source.projectId);
      if (target.channelDigest) yield* recordChannelMessage(message, target.id);
    }

    if (
      config.requireMention &&
      message.channelType === "discord" &&
      message.threadId === undefined &&
      message.mentionsBot !== true
    ) {
      return { kind: "not_mentioned" } as InboundOutcome;
    }

    if (!source) return { kind: "unlinked" } as InboundOutcome;
    if (!replay) yield* acknowledge();

    const project = yield* projects.get(source.projectId);
    const at = yield* nowIso;

    const sidekickAnswer = (ticketId: string, prompt: string) =>
      askSidekick({ ticketId, prompt, requestId: message.externalId }).pipe(
        Effect.map((text) => ({ ok: true as const, text })),
        Effect.catchTag("SidekickError", (e) =>
          Effect.succeed({ ok: false as const, text: e.message }),
        ),
      );

    const addFollowUp = (ticketId: string) =>
      Effect.gen(function* () {
        const stored = yield* storeAttachments(ticketId, message, config.attachments);
        yield* tickets.appendEvent({
          id: yield* ids.next,
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
          createdAt: at,
        });
        return { kind: "follow_up_added", ticketId } as InboundOutcome;
      });

    /** The ticket as the classifier sees it: what was asked, where it is, its last result. */
    const describeTicket = (ticket: Ticket) =>
      Effect.map(tickets.listEvents(ticket.id), (events) => {
        const lastResult = events.findLast((e) => e.type === "result")?.body;
        return ticketContext({
          title: ticket.title,
          inputSummary: ticket.inputSummary,
          status: ticket.status,
          ...(lastResult === undefined ? {} : { lastResult }),
        });
      });

    /** Asks whether a thread message is new work; the click replays it (`answerScopePrompt`). */
    const askScope = (ticketId: string, threadId: string, result: IntentResult) =>
      askPrompt({
        target: { channelType: message.channelType, channelId: message.channelId, threadId },
        kind: "choice",
        question: SCOPE_PROMPT_QUESTION,
        options: [NEW_TICKET_OPTION, SAME_TICKET_OPTION],
      }).pipe(
        Effect.tap((prompt) =>
          kv.set(scopeKey(prompt.id), JSON.stringify({ message, result }), {
            ttlSeconds: PROMPT_TTL_SECONDS,
          }),
        ),
        Effect.map(
          (prompt) => ({ kind: "scope_asked", ticketId, promptId: prompt.id }) as InboundOutcome,
        ),
        // No buttons (e.g. no permission): keep the message on this ticket, as before.
        Effect.catch((err) =>
          Effect.as(
            Effect.logWarning(
              `could not ask about the scope of ${message.externalId}`,
              err.message,
            ),
            undefined,
          ),
        ),
      );

    // A message in a ticket's thread belongs to that ticket, unless it asks how the ticket is
    // going, is small talk on a finished ticket, or is clearly different work (then a click
    // decides). Once that click says it's different work, it is routed as a channel message.
    const thread =
      message.threadId === undefined
        ? undefined
        : yield* tickets.findByThread(message.channelType, message.threadId);
    const threadTicket = thread && (yield* tickets.get(thread.ticketId));
    if (
      threadTicket &&
      threadTicket.projectId === project.id &&
      override?.scope !== "out_of_scope"
    ) {
      // A Sidekick ticket is finished the moment it is answered, so its thread keeps talking
      // to the same Sidekick conversation instead of hitting the closed-ticket reply.
      if (threadTicket.workerType === "sidekick") {
        yield* addFollowUp(threadTicket.id);
        const answered = yield* sidekickAnswer(threadTicket.id, message.content);
        yield* reply(answered.ok ? answered.text : sidekickFailedMessage(answered.text));
        return { kind: "sidekick_answered", ticketId: threadTicket.id } as InboundOutcome;
      }
      if (!replay) {
        const result = yield* classify(
          project.customInstructions,
          project.id,
          yield* describeTicket(threadTicket),
        );
        const confident = isConfident(result.confidence);
        if (confident && result.intent === "status_question") {
          const text = yield* runtime.respond({
            sessionId: `project:${project.id}`,
            requestId: message.externalId,
            prompt: statusQuestion({ question: message.content, tickets: [threadTicket] }),
          });
          yield* reply(text);
          return { kind: "status_answered" } as InboundOutcome;
        }
        // "thanks!" under a finished ticket is not a reason to start it again.
        if (confident && result.intent === "chit_chat" && isTerminal(threadTicket.status)) {
          return { kind: "chit_chat_ignored", ticketId: threadTicket.id } as InboundOutcome;
        }
        if (
          confident &&
          result.intent === "new_request" &&
          result.scope?.choice === "out_of_scope" &&
          isConfident(result.scope.confidence)
        ) {
          const asked = yield* askScope(threadTicket.id, thread.threadId, result);
          if (asked) return asked;
        }
      }
      // A follow-up on a finished or blocked ticket reopens it and places it again; the next
      // Worker reads the earlier events and the new ask on the ticket. A cancelled one stays closed.
      if (canReopen(threadTicket.status)) {
        const added = yield* addFollowUp(threadTicket.id);
        const reopened = yield* reopenForFollowUp(
          threadTicket,
          { channelType: message.channelType, ...message.sender },
          config,
          at,
        );
        if (!reopened) return added;
        yield* reply(reopenedMessage(threadTicket.status, reopened.queued));
        return { kind: "ticket_reopened", ticket: reopened.ticket } as InboundOutcome;
      }
      if (isTerminal(threadTicket.status)) {
        yield* reply(TICKET_CLOSED_MESSAGE);
        return { kind: "ticket_closed", ticketId: threadTicket.id } as InboundOutcome;
      }
      return yield* addFollowUp(threadTicket.id);
    }

    const result = override?.result ?? (yield* classify(project.customInstructions, project.id));
    if (!isConfident(result.confidence)) return yield* clarify();

    const active = (yield* tickets.listByStatus(ACTIVE_STATUSES))
      .filter((t) => t.projectId === project.id)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

    switch (result.intent) {
      case "new_request": {
        const ticketId = yield* ids.next;
        const requester = { channelType: message.channelType, id: message.sender.id };
        const created = yield* tickets.insert({
          id: ticketId,
          projectId: project.id,
          status: "open",
          title: message.content.slice(0, TITLE_MAX),
          intent: result.intent,
          inputSummary: message.content,
          priority: null,
          workerType: null,
          workerId: null,
          requester,
          result: null,
          error: null,
          createdAt: at,
          assignedAt: null,
          startedAt: null,
          lastActivityAt: at,
          completedAt: null,
          updatedAt: at,
        });
        yield* auditTicket(created, "created", {
          type: "person",
          id: message.sender.id,
          name: message.sender.name ?? null,
        });
        // A tool-only Sidekick ticket never opens its files, so they are not copied.
        const stored =
          result.executor === "sidekick"
            ? (new Set() as ReadonlySet<string>)
            : yield* storeAttachments(ticketId, message, config.attachments);
        yield* tickets.appendEvent({
          id: yield* ids.next,
          ticketId,
          type: "created",
          actor: "coordinator",
          actorId: null,
          body: message.content,
          payload: {
            sender: message.sender,
            channelType: message.channelType,
            ...attachmentsPayload(message, stored),
          },
          createdAt: at,
        });
        if (result.executor === "sidekick") {
          // Tool-only: placed at once under the Sidekick's own id, answered in the ticket's
          // thread, and finished. Everything else waits for a pull-model Worker.
          yield* placeOrQueue({ ticketId, requester, executor: "sidekick", routing: config, at });
          const threadId = yield* openTicketThread(ticketId, at);
          const answered = yield* sidekickAnswer(ticketId, message.content);
          if (answered.ok) {
            yield* tickets.appendEvent({
              id: yield* ids.next,
              ticketId,
              type: "result",
              actor: "worker",
              actorId: SIDEKICK_WORKER_ID,
              body: answered.text,
              payload: null,
              createdAt: at,
            });
            yield* updateStatus({ ticketId, status: "completed" });
            yield* replyIn(threadId, answered.text);
          } else {
            yield* tickets.appendEvent({
              id: yield* ids.next,
              ticketId,
              type: "error",
              actor: "worker",
              actorId: SIDEKICK_WORKER_ID,
              body: answered.text,
              payload: null,
              createdAt: at,
            });
            yield* updateStatus({ ticketId, status: "failed", error: answered.text });
            yield* replyIn(threadId, sidekickFailedMessage(answered.text));
          }
          return { kind: "ticket_created", ticket: yield* tickets.get(ticketId) } as InboundOutcome;
        }
        const placement = yield* placeOrQueue({ ticketId, requester, routing: config, at });
        const threadId = yield* openTicketThread(ticketId, at);
        if (placement.kind === "queued") yield* replyIn(threadId, QUEUED_MESSAGE);
        return { kind: "ticket_created", ticket: placement.ticket } as InboundOutcome;
      }
      case "follow_up": {
        const target = active[0];
        if (!target) return yield* clarify();
        return yield* addFollowUp(target.id);
      }
      case "status_question": {
        const text = yield* runtime.respond({
          sessionId: `project:${project.id}`,
          requestId: message.externalId,
          prompt: statusQuestion({ question: message.content, tickets: active }),
        });
        yield* reply(text);
        return { kind: "status_answered" } as InboundOutcome;
      }
      case "remember": {
        yield* writeMemory({
          projectId: project.id,
          type: "manual",
          title: message.content.slice(0, TITLE_MAX),
          content: message.content,
          sourceMetadata: { sender: message.sender, channelType: message.channelType },
        });
        yield* reply(MEMORY_SAVED_MESSAGE);
        return { kind: "memory_saved" } as InboundOutcome;
      }
      default:
        return yield* clarify();
    }
  }).pipe(
    // Only messages that reached the classifier get a `classified` row, written once the
    // outcome is known so the row says what the Coordinator did with the answer.
    Effect.onExit((exit) => {
      const classified = classification;
      if (!classified) return Effect.void;
      const outcome = Exit.isSuccess(exit) ? exit.value : undefined;
      const ticketId =
        outcome?.kind === "ticket_created"
          ? outcome.ticket.id
          : outcome && "ticketId" in outcome
            ? outcome.ticketId
            : undefined;
      const error =
        classified.error ?? (Exit.isFailure(exit) ? errorMessage(exit.cause) : undefined);
      return auditClassification({
        message,
        projectId: classified.projectId,
        ...(classified.result && { result: classified.result }),
        threshold,
        // Every gate that ends handling runs before the classifier.
        outcome: (outcome?.kind ?? "error") as ClassifiedOutcome,
        ...(ticketId !== undefined && { ticketId }),
        ...(error !== undefined && { error }),
      });
    }),
  );
};

/**
 * A Worker that asked with `ticket_ask` and couldn't go on without the answer set its ticket to
 * blocked and ended its session, so the answer resumes the ticket like a thread follow-up.
 */
const resumeAnsweredTicket = (answer: PromptAnswer, inbound: HandleInboundConfig) =>
  Effect.gen(function* () {
    const prompt = yield* getPrompt({ promptId: answer.promptId });
    if (prompt.ticketId === null) return;
    const ticket = yield* Effect.flatMap(TicketRepository, (r) => r.get(prompt.ticketId!));
    if (ticket.status !== "blocked") return;
    const at = yield* nowIso;
    const resumed = yield* reopenForFollowUp(
      ticket,
      { channelType: answer.channelType, ...answer.sender },
      inbound,
      at,
    );
    if (resumed) yield* notifyTicket(ticket.id, reopenedMessage(ticket.status, resumed.queued));
  }).pipe(
    Effect.catch((err) =>
      Effect.logWarning(`could not resume the ticket of prompt ${answer.promptId}`, err.message),
    ),
  );

/**
 * Records a click on a prompt (`answerPrompt`). A scope prompt's click then routes the message
 * it asked about: "New ticket" opens one in a new thread and links it, "Part of this ticket"
 * makes it a follow-up on the thread's ticket (reopening a finished one).
 */
export const answerScopePrompt = (
  answer: PromptAnswer,
  prompts: PromptAnswerConfig,
  inbound: HandleInboundConfig,
) =>
  Effect.gen(function* () {
    const replied = yield* answerPrompt(answer, prompts);
    if (!replied.accepted) return replied;
    const kv = yield* KeyValueStore;
    const raw = yield* kv.get(scopeKey(answer.promptId));
    if (raw === undefined) {
      yield* resumeAnsweredTicket(answer, inbound);
      return replied;
    }
    yield* kv.delete(scopeKey(answer.promptId));
    const asked = decodeScopeAsk(raw);
    if (asked._tag === "None") return replied;
    yield* handleInbound(asked.value.message, inbound, {
      scope: answer.choice === 0 ? "out_of_scope" : "in_scope",
      result: asked.value.result,
    });
    return replied;
  });
