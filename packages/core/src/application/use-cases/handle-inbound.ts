import type { InboundMessage, ReplyInstruction } from "@project-os/contracts";
import { statusQuestion } from "@project-os/system-prompts";
import { Cause, Effect, Exit } from "effect";
import { ACTIVE_STATUSES, isTerminal, type Ticket } from "../../domain/index.ts";
import {
  AgentRuntime,
  ChannelGateway,
  IdGenerator,
  IntentClassifier,
  type IntentResult,
  KeyValueStore,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
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
  "This ticket is finished. Post in the channel to start something new.";

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

export const handleInbound = (message: InboundMessage, config: HandleInboundConfig) => {
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
        const threadId =
          message.threadId ??
          (yield* gateway
            .createThread({
              channelType: message.channelType,
              channelId: message.channelId,
              messageId: message.externalId,
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
          content: THREAD_OPENED_MESSAGE,
        });
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

    const fresh = yield* kv.setIfAbsent(
      `inbound:${message.channelType}:${message.externalId}`,
      "1",
      { ttlSeconds: config.dedupeTtlSeconds ?? 86_400 },
    );
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
    yield* auditInbound(message, source?.projectId ?? null, { admin: isAdminChannel });

    if (isAdminChannel && config.adminUserIds && !config.adminUserIds.includes(message.sender.id)) {
      yield* reply("Not authorized: you are not on the admin list.");
      return { kind: "admin_forbidden" } as InboundOutcome;
    }

    const classify = (projectContext: string, projectId: string | null) =>
      classifier.classify({ content: message.content, projectContext }).pipe(
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
    if (source && config.channelDigest && message.channelType === "discord") {
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
    yield* acknowledge();

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

    // A message in a ticket's thread belongs to that ticket, whatever the classifier says,
    // unless it asks how the ticket is going.
    const thread =
      message.threadId === undefined
        ? undefined
        : yield* tickets.findByThread(message.channelType, message.threadId);
    const threadTicket = thread && (yield* tickets.get(thread.ticketId));
    if (threadTicket && threadTicket.projectId === project.id) {
      // A Sidekick ticket is finished the moment it is answered, so its thread keeps talking
      // to the same Sidekick conversation instead of hitting the closed-ticket reply.
      if (threadTicket.workerType === "sidekick") {
        yield* addFollowUp(threadTicket.id);
        const answered = yield* sidekickAnswer(threadTicket.id, message.content);
        yield* reply(answered.ok ? answered.text : sidekickFailedMessage(answered.text));
        return { kind: "sidekick_answered", ticketId: threadTicket.id } as InboundOutcome;
      }
      const result = yield* classify(project.customInstructions, project.id);
      if (isConfident(result.confidence) && result.intent === "status_question") {
        const text = yield* runtime.respond({
          sessionId: `project:${project.id}`,
          requestId: message.externalId,
          prompt: statusQuestion({ question: message.content, tickets: [threadTicket] }),
        });
        yield* reply(text);
        return { kind: "status_answered" } as InboundOutcome;
      }
      if (isTerminal(threadTicket.status)) {
        yield* reply(TICKET_CLOSED_MESSAGE);
        return { kind: "ticket_closed", ticketId: threadTicket.id } as InboundOutcome;
      }
      return yield* addFollowUp(threadTicket.id);
    }

    const result = yield* classify(project.customInstructions, project.id);
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
