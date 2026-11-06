import { Schema } from "effect";
import {
  CreateChannelInstruction,
  CreateThreadInstruction,
  PromptInstruction,
  ReplyInstruction,
} from "@project-os/contracts";
import { Elysia } from "elysia";
import { type ActionRow, promptComponents } from "./prompts.ts";

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
/** Posts a message with components (a prompt's buttons); resolves to the message's id. */
export type PostDiscordPrompt = (
  target: ReplyTarget,
  message: { content: string; components: ActionRow[] },
) => Promise<{ messageId: string }>;

const decode = Schema.decodeUnknownOption(ReplyInstruction);
const decodeCreate = Schema.decodeUnknownOption(CreateChannelInstruction);
const decodeThread = Schema.decodeUnknownOption(CreateThreadInstruction);
const decodePrompt = Schema.decodeUnknownOption(PromptInstruction);

/**
 * Coordinator-facing endpoints: `/reply` posts a message, `/channels` creates a channel,
 * `/threads` opens a thread on a message, `/prompts` posts a question with buttons. All execute
 * Coordinator instructions; no decisions are made here. Without `createChannel` /
 * `createThread` / `postPrompt`, that endpoint answers 501.
 */
export const createReplyApp = (
  post: PostToDiscord,
  createChannel?: CreateDiscordChannel,
  createThread?: CreateDiscordThread,
  postPrompt?: PostDiscordPrompt,
) =>
  new Elysia()
    .post("/prompts", async ({ body, set }) => {
      const parsed = decodePrompt(body);
      if (parsed._tag === "None" || parsed.value.channelType !== "discord") {
        set.status = 400;
        return { error: "invalid prompt instruction" };
      }
      if (!postPrompt) {
        set.status = 501;
        return { error: "this adapter can't post prompts" };
      }
      const { channelId, threadId, content } = parsed.value;
      try {
        return await postPrompt(threadId === undefined ? { channelId } : { channelId, threadId }, {
          content,
          components: promptComponents(parsed.value),
        });
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord prompt post failed" };
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
