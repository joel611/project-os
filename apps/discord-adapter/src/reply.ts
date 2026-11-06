import { Schema } from "effect";
import {
  CreateChannelInstruction,
  CreateThreadInstruction,
  ReactInstruction,
  ReplyInstruction,
} from "@project-os/contracts";
import { Elysia } from "elysia";

export interface ReplyTarget {
  channelId: string;
  threadId?: string;
}
export type PostToDiscord = (target: ReplyTarget, content: string) => Promise<void>;
/** Creates a text channel; resolves to its id and Discord's final name. */
export type CreateDiscordChannel = (name: string) => Promise<{ channelId: string; name: string }>;
/** Starts a public thread on a message; resolves to the thread's id. */
export type CreateDiscordThread = (input: {
  channelId: string;
  messageId: string;
  name: string;
}) => Promise<{ threadId: string }>;
/** Adds a reaction to a message; `threadId` is set when the message is inside a thread. */
export type ReactInDiscord = (input: {
  channelId: string;
  threadId?: string;
  messageId: string;
  emoji: string;
}) => Promise<void>;

const decode = Schema.decodeUnknownOption(ReplyInstruction);
const decodeCreate = Schema.decodeUnknownOption(CreateChannelInstruction);
const decodeThread = Schema.decodeUnknownOption(CreateThreadInstruction);
const decodeReact = Schema.decodeUnknownOption(ReactInstruction);

/**
 * Coordinator-facing endpoints: `/reply` posts a message, `/channels` creates a channel,
 * `/threads` opens a thread on a message, `/reactions` reacts to one. All execute Coordinator
 * instructions; no decisions are made here. Without `createChannel` / `createThread` /
 * `react`, that endpoint answers 501.
 */
export const createReplyApp = (
  post: PostToDiscord,
  createChannel?: CreateDiscordChannel,
  createThread?: CreateDiscordThread,
  react?: ReactInDiscord,
) =>
  new Elysia()
    .post("/reactions", async ({ body, set }) => {
      const parsed = decodeReact(body);
      if (parsed._tag === "None" || parsed.value.channelType !== "discord") {
        set.status = 400;
        return { error: "invalid reaction instruction" };
      }
      if (!react) {
        set.status = 501;
        return { error: "this adapter can't react to messages" };
      }
      const { channelId, threadId, messageId, emoji } = parsed.value;
      try {
        await react({
          channelId,
          ...(threadId === undefined ? {} : { threadId }),
          messageId,
          emoji,
        });
        return { ok: true };
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord reaction failed" };
      }
    })
    .post("/threads", async ({ body, set }) => {
      const parsed = decodeThread(body);
      if (parsed._tag === "None" || parsed.value.channelType !== "discord") {
        set.status = 400;
        return { error: "invalid create thread instruction" };
      }
      if (!createThread) {
        set.status = 501;
        return { error: "this adapter can't open threads" };
      }
      const { channelId, messageId, name } = parsed.value;
      try {
        return await createThread({ channelId, messageId, name });
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord thread create failed" };
      }
    })
    .post("/channels", async ({ body, set }) => {
      const parsed = decodeCreate(body);
      if (parsed._tag === "None" || parsed.value.channelType !== "discord") {
        set.status = 400;
        return { error: "invalid create channel instruction" };
      }
      if (!createChannel) {
        set.status = 501;
        return { error: "this adapter can't create channels" };
      }
      try {
        return await createChannel(parsed.value.name);
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord channel create failed" };
      }
    })
    .post("/reply", async ({ body, set }) => {
      const parsed = decode(body);
      if (parsed._tag === "None" || parsed.value.channelType !== "discord") {
        set.status = 400;
        return { error: "invalid reply instruction" };
      }
      const { channelId, threadId, content } = parsed.value;
      try {
        await post(threadId === undefined ? { channelId } : { channelId, threadId }, content);
        return { ok: true };
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord post failed" };
      }
    });
