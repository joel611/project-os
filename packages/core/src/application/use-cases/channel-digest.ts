import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import {
  ChannelDigester,
  ChannelGateway,
  ChannelMessageRepository,
  Clock,
  IdGenerator,
  KeyValueStore,
  MemoryRepository,
  ProjectRepository,
} from "../ports/index.ts";
import { writeMemory } from "./memory.ts";

/** `createdBy` on memory entries the Channel Digest saves. */
export const CHANNEL_DIGEST_AUTHOR = "channel-digest";

export interface ChannelDigestConfig {
  /** Digest a project once its channel has been quiet this long. */
  readonly quietMs: number;
  /** ...or once its oldest waiting message is this old, even if people are still talking. */
  readonly maxWaitMs: number;
  /** Waiting messages older than this are dropped unread (a digest that keeps failing). */
  readonly retentionMs: number;
  /** Most messages one digest reads; the rest wait for the next run. */
  readonly maxMessages: number;
  /** Post what was saved in the channel, so people can see it and set it right. */
  readonly notify: boolean;
  /** After a failed digest, wait this long before trying that project again. */
  readonly retryAfterMs?: number;
}

export const DEFAULT_CHANNEL_DIGEST: ChannelDigestConfig = {
  quietMs: 30 * 60_000,
  maxWaitMs: 6 * 60 * 60_000,
  retentionMs: 7 * 24 * 60 * 60_000,
  maxMessages: 200,
  notify: false,
};

/** How many recent memory titles the digester sees, to avoid saving a point twice. */
const KNOWN_TITLES = 50;
const TITLE_MAX = 80;

/** Keeps a project channel message for the Channel Digest. Empty (file-only) messages are skipped. */
export const recordChannelMessage = (message: InboundMessage, projectId: string) =>
  Effect.gen(function* () {
    if (message.content.trim() === "") return false;
    const repo = yield* ChannelMessageRepository;
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
      content: message.content,
      sentAt: message.receivedAt,
    });
  });

export const digestNotice = (points: ReadonlyArray<{ type: string; title: string }>) =>
  [
    "From the recent discussion, I saved this to the project memory:",
    ...points.map((p) => `- ${p.type === "decision" ? "Decision" : "Note"}: ${p.title}`),
  ].join("\n");

export interface DigestRun {
  readonly projectId: string;
  readonly messages: number;
  readonly saved: number;
  readonly error?: string;
}

/**
 * The Channel Digest: for each project whose channel conversation has gone quiet (or waited
 * long enough), reads the waiting messages, saves the decisions and facts in them to Project
 * Memory, and drops the messages. Safe to run every minute; a project is digested by one run at
 * a time, and a failed one is retried after `retryAfterMs`.
 */
export const digestChannels = (config: ChannelDigestConfig) =>
  Effect.gen(function* () {
    const repo = yield* ChannelMessageRepository;
    const kv = yield* KeyValueStore;
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const nowMs = now.getTime();

    yield* repo.removeSentBefore(new Date(nowMs - config.retentionMs).toISOString());

    const due = (yield* repo.pending).filter(
      (p) =>
        nowMs - Date.parse(p.newestAt) >= config.quietMs ||
        nowMs - Date.parse(p.oldestAt) >= config.maxWaitMs,
    );

    const runs: DigestRun[] = [];
    for (const pending of due) {
      if (yield* kv.get(`digest:retry:${pending.projectId}`)) continue;
      const locked = yield* kv.setIfAbsent(`digest:lock:${pending.projectId}`, "1", {
        ttlSeconds: 300,
      });
      if (!locked) continue;
      const run = yield* digestProject(pending.projectId, config).pipe(
        Effect.catchTag("ChannelDigestError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`channel digest failed for ${pending.projectId}`, e.message);
            yield* kv.set(`digest:retry:${pending.projectId}`, "1", {
              ttlSeconds: Math.max(60, Math.round((config.retryAfterMs ?? 10 * 60_000) / 1000)),
            });
            return { projectId: pending.projectId, messages: 0, saved: 0, error: e.message };
          }),
        ),
        Effect.ensuring(kv.delete(`digest:lock:${pending.projectId}`)),
      );
      runs.push(run);
    }
    return runs;
  });

const digestProject = (projectId: string, config: ChannelDigestConfig) =>
  Effect.gen(function* () {
    const repo = yield* ChannelMessageRepository;
    const digester = yield* ChannelDigester;
    const gateway = yield* ChannelGateway;
    const project = yield* (yield* ProjectRepository).get(projectId).pipe(Effect.orDie);
    const messages = yield* repo.list(projectId, config.maxMessages);
    if (messages.length === 0) return { projectId, messages: 0, saved: 0 };
    const known = (yield* (yield* MemoryRepository).list(projectId, { limit: KNOWN_TITLES })).map(
      (m) => m.title,
    );

    const points = yield* digester.digest({
      projectName: project.name,
      projectContext: project.customInstructions,
      known,
      messages: messages.map((m) => ({
        id: m.externalId,
        sender: m.senderName ?? m.senderId,
        content: m.content,
        sentAt: m.sentAt,
        ...(m.threadId === null ? {} : { threadId: m.threadId }),
      })),
    });

    const byExternal = new Map(messages.map((m) => [m.externalId, m]));
    for (const point of points) {
      const sources = point.messageIds.flatMap((id) => byExternal.get(id) ?? []);
      const threadIds = [...new Set(sources.flatMap((m) => m.threadId ?? []))];
      yield* writeMemory({
        projectId,
        type: point.type,
        title: point.title.slice(0, TITLE_MAX),
        content: point.content,
        workerId: CHANNEL_DIGEST_AUTHOR,
        sourceMetadata: {
          source: "channel_digest",
          channelType: messages[0]!.channelType,
          channelId: messages[0]!.channelId,
          messageIds: sources.map((m) => m.externalId),
          ...(threadIds.length === 0 ? {} : { threadIds }),
          senders: [...new Set(sources.map((m) => m.senderName ?? m.senderId))],
        },
      });
    }
    yield* repo.remove(messages.map((m) => m.id));

    if (config.notify && points.length > 0) {
      const last = messages[messages.length - 1]!;
      yield* gateway.send({
        channelType: last.channelType,
        channelId: last.channelId,
        content: digestNotice(points),
      });
    }
    return { projectId, messages: messages.length, saved: points.length };
  });
