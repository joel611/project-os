import type { InboundMessage, ReplyInstruction, WorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { ACTIVE_STATUSES, type Ticket } from "../../domain/index.ts";
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
import { sourceTypeFor } from "./channels.ts";
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
  | { readonly kind: "status_answered" }
  | { readonly kind: "admin_handled" }
  | { readonly kind: "admin_forbidden" }
  | { readonly kind: "clarification_sent" };

const TITLE_MAX = 80;

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
    const result = yield* classify(project.customInstructions);
    if (!isConfident(result.confidence)) return yield* clarify();

    const at = yield* nowIso;
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
        return { kind: "ticket_created", ticket: assigned } as InboundOutcome;
      }
      case "follow_up": {
        const target = active[0];
        if (!target) return yield* clarify();
        yield* tickets.appendEvent({
          id: yield* ids.next,
          ticketId: target.id,
          type: "follow_up",
          actor: "coordinator",
          actorId: message.sender.id,
          body: message.content,
          payload: { sender: message.sender, channelType: message.channelType },
          createdAt: at,
        });
        return { kind: "follow_up_added", ticketId: target.id } as InboundOutcome;
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
