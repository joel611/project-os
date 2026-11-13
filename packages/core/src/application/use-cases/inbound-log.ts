import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import { IdGenerator, InboundLogRepository, ProjectRepository } from "../ports/index.ts";

/** Most entries one read returns. */
export const INBOUND_LOG_LIMIT = 200;

/** Discord user, role and channel mentions plus @everyone/@here. */
const MENTION = /<(?:@[!&]?|#)\d+>|@everyone|@here/g;

export const stripMentions = (content: string): string =>
  content.replace(MENTION, " ").replace(/\s+/g, " ").trim();

/** Keeps a message received in a project's channel so the dashboard can show what arrived. */
export const recordInbound = (message: InboundMessage, projectId: string) =>
  Effect.gen(function* () {
    const repo = yield* InboundLogRepository;
    const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    return yield* repo.append({
      id,
      projectId,
      channelType: message.channelType,
      channelId: message.channelId,
      threadId: message.threadId ?? null,
      externalId: message.externalId,
      senderId: message.sender.id,
      senderName: message.sender.name ?? null,
      content: stripMentions(message.content),
      mentionsBot: message.mentionsBot === true,
      attachmentCount: message.attachments?.length ?? 0,
      url: message.url ?? null,
      receivedAt: message.receivedAt,
    });
  });

export const readInbound = (projectId: string) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(projectId);
    return yield* (yield* InboundLogRepository).list(projectId, INBOUND_LOG_LIMIT);
  });
