import type { InboundMessage, ReplyInstruction, WorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { ACTIVE_STATUSES, isTerminal, type Ticket } from "../../domain/index.ts";
import {
  AgentRuntime,
  ChannelGateway,
  IdGenerator,
  IntentClassifier,
  KeyValueStore,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
} from "../ports/index.ts";
import { sourceTypeFor, supportsThreads } from "./channels.ts";
import { nowIso } from "./tickets.ts";

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
  readonly defaultWorkerType?: WorkerType;
  /**
   * Worker to assign new tickets to. `ticket_claim` only admits the assigned `worker_id`,
   * so leave unset only if something else assigns later.
   */
  readonly workerId?: string;
  readonly dedupeTtlSeconds?: number;
}

export type InboundOutcome =
  | { readonly kind: "duplicate" }
  | { readonly kind: "unlinked" }
  | { readonly kind: "ticket_created"; readonly ticket: Ticket }
  | { readonly kind: "follow_up_added"; readonly ticketId: string }
  | { readonly kind: "ticket_closed"; readonly ticketId: string }
  | { readonly kind: "status_answered" }
  | { readonly kind: "admin_handled" }
  | { readonly kind: "admin_forbidden" }
  | { readonly kind: "clarification_sent" };

const TITLE_MAX = 80;

export const THREAD_OPENED_MESSAGE =
  "I opened a ticket for this. Keep the conversation for it in this thread.";
export const TICKET_CLOSED_MESSAGE =
  "This ticket is finished. Post in the channel to start something new.";

export const handleInbound = (message: InboundMessage, config: HandleInboundConfig) =>
  Effect.gen(function* () {
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
        if (!supportsThreads(message.channelType)) return;
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
        if (threadId === undefined) return;
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
      });

    const fresh = yield* kv.setIfAbsent(
      `inbound:${message.channelType}:${message.externalId}`,
      "1",
      { ttlSeconds: config.dedupeTtlSeconds ?? 86_400 },
    );
    if (!fresh) return { kind: "duplicate" } satisfies InboundOutcome as InboundOutcome;

    const isAdminChannel =
      message.channelType === "discord" && message.channelId === config.adminChannelId;

    if (isAdminChannel && config.adminUserIds && !config.adminUserIds.includes(message.sender.id)) {
      yield* reply("Not authorized: you are not on the admin list.");
      return { kind: "admin_forbidden" } as InboundOutcome;
    }

    const classify = (projectContext: string) =>
      classifier.classify({ content: message.content, projectContext });
    const isConfident = (confidence: number) => confidence >= (config.confidenceThreshold ?? 0.5);

    if (isAdminChannel) {
      const result = yield* classify("");
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

    const sourceType = sourceTypeFor(message.channelType);
    const source = sourceType
      ? yield* sources.findByExternal(sourceType, message.channelId)
      : undefined;
    if (!source) return { kind: "unlinked" } as InboundOutcome;

    const project = yield* projects.get(source.projectId);
    const at = yield* nowIso;

    const addFollowUp = (ticketId: string) =>
      Effect.gen(function* () {
        yield* tickets.appendEvent({
          id: yield* ids.next,
          ticketId,
          type: "follow_up",
          actor: "coordinator",
          actorId: message.sender.id,
          body: message.content,
          payload: { sender: message.sender },
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
      const result = yield* classify(project.customInstructions);
      if (isConfident(result.confidence) && result.intent === "status_question") {
        const text = yield* runtime.respond({
          sessionId: `project:${project.id}`,
          requestId: message.externalId,
          prompt: [
            `Answer this status question from ticket state: ${message.content}`,
            `- ${threadTicket.title} [${threadTicket.status}]`,
          ].join("\n"),
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

    const result = yield* classify(project.customInstructions);
    if (!isConfident(result.confidence)) return yield* clarify();

    const active = (yield* tickets.listByStatus(ACTIVE_STATUSES))
      .filter((t) => t.projectId === project.id)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

    switch (result.intent) {
      case "new_request": {
        const workerType = result.workerType ?? config.defaultWorkerType ?? "local_claude";
        const ticketId = yield* ids.next;
        yield* tickets.insert({
          id: ticketId,
          projectId: project.id,
          status: "open",
          title: message.content.slice(0, TITLE_MAX),
          intent: result.intent,
          inputSummary: message.content,
          priority: null,
          workerType: null,
          workerId: null,
          result: null,
          error: null,
          createdAt: at,
          assignedAt: null,
          startedAt: null,
          lastActivityAt: at,
          completedAt: null,
          updatedAt: at,
        });
        yield* tickets.appendEvent({
          id: yield* ids.next,
          ticketId,
          type: "created",
          actor: "coordinator",
          actorId: null,
          body: message.content,
          payload: { sender: message.sender, channelType: message.channelType },
          createdAt: at,
        });
        const assigned = yield* tickets.assign(
          ticketId,
          { workerType, workerId: config.workerId ?? null },
          at,
        );
        yield* tickets.appendEvent({
          id: yield* ids.next,
          ticketId,
          type: "assigned",
          actor: "coordinator",
          actorId: null,
          body: `Assigned to ${config.workerId ?? workerType}`,
          payload: { workerType, workerId: config.workerId ?? null },
          createdAt: at,
        });
        yield* openTicketThread(ticketId, at);
        return { kind: "ticket_created", ticket: assigned } as InboundOutcome;
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
          prompt: [
            `Answer this status question from ticket state: ${message.content}`,
            ...(active.length === 0
              ? ["No open tickets."]
              : active.map((t) => `- ${t.title} [${t.status}]`)),
          ].join("\n"),
        });
        yield* reply(text);
        return { kind: "status_answered" } as InboundOutcome;
      }
      default:
        return yield* clarify();
    }
  });
