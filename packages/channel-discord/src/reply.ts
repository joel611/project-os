import { Schema } from "effect";
import {
  CreateChannelInstruction,
  CreateThreadInstruction,
  InboundAttachment,
  ReactInstruction,
  ResolveAttachmentsInstruction,
  PromptInstruction,
  ReplyInstruction,
} from "@project-os/contracts";
import { Elysia } from "elysia";
import { type ActionRow, promptComponents } from "./prompts.ts";

export interface ReplyTarget {
  channelId: string;
  threadId?: string;
}
/** A file posted with a reply, already downloaded. */
export interface ReplyUpload {
  filename: string;
  data: Uint8Array;
}
export type PostToDiscord = (
  target: ReplyTarget,
  content: string,
  files?: ReadonlyArray<ReplyUpload>,
) => Promise<void>;
/** Creates a text channel; resolves to its id and Discord's final name. */
export type CreateDiscordChannel = (name: string) => Promise<{ channelId: string; name: string }>;
/** Starts a public thread on a message; resolves to the thread's id. */
export type CreateDiscordThread = (input: {
  channelId: string;
  /** Unset: a thread in the channel with no starter message. */
  messageId?: string;
  name: string;
}) => Promise<{ threadId: string }>;
/** Adds a reaction to a message; `threadId` is set when the message is inside a thread. */
export type ReactInDiscord = (input: {
  channelId: string;
  threadId?: string;
  messageId: string;
  emoji: string;
}) => Promise<void>;
/** Re-reads a message and returns its files with fresh download links. */
export type ResolveDiscordAttachments = (input: {
  channelId: string;
  messageId: string;
}) => Promise<ReadonlyArray<InboundAttachment>>;
/** Posts a message with components (a prompt's buttons); resolves to the message's id. */
export type PostDiscordPrompt = (
  target: ReplyTarget,
  message: { content: string; components: ActionRow[] },
) => Promise<{ messageId: string }>;

const decode = Schema.decodeUnknownOption(ReplyInstruction);
const decodeCreate = Schema.decodeUnknownOption(CreateChannelInstruction);
const decodeThread = Schema.decodeUnknownOption(CreateThreadInstruction);
const decodeReact = Schema.decodeUnknownOption(ReactInstruction);
const decodeResolve = Schema.decodeUnknownOption(ResolveAttachmentsInstruction);

const decodePrompt = Schema.decodeUnknownOption(PromptInstruction);

/**
 * Coordinator-facing endpoints: `/reply` posts a message, `/channels` creates a channel,
 * `/threads` opens a thread on a message, `/reactions` reacts to one, `/prompts` posts a
 * question with buttons, `/attachments` re-reads a message for fresh file links. All execute
 * Coordinator instructions; no decisions are made here.
 * Without `createChannel` / `createThread` / `react` / `postPrompt` / `resolveAttachments`,
 * that endpoint answers 501.
 */
export const createReplyApp = (
  post: PostToDiscord,
  createChannel?: CreateDiscordChannel,
  createThread?: CreateDiscordThread,
  react?: ReactInDiscord,
  postPrompt?: PostDiscordPrompt,
  resolveAttachments?: ResolveDiscordAttachments,
) =>
  new Elysia()
    .post("/attachments", async ({ body, set }) => {
      const parsed = decodeResolve(body);
      if (parsed._tag === "None" || parsed.value.channelType !== "discord") {
        set.status = 400;
        return { error: "invalid attachments instruction" };
      }
      if (!resolveAttachments) {
        set.status = 501;
        return { error: "this adapter can't read attachments" };
      }
      try {
        const { channelId, messageId } = parsed.value;
        return { attachments: await resolveAttachments({ channelId, messageId }) };
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord attachments read failed" };
      }
    })
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
        return await createThread({
          channelId,
          ...(messageId === undefined ? {} : { messageId }),
          name,
        });
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
      const { channelId, threadId, content, files } = parsed.value;
      try {
        const target = threadId === undefined ? { channelId } : { channelId, threadId };
        if (files === undefined || files.length === 0) {
          await post(target, content);
        } else {
          const uploads = await Promise.all(
            files.map(async ({ filename, url }) => {
              // The Coordinator's own signed link: no redirects, so it can't be pointed elsewhere.
              const res = await fetch(url, { redirect: "manual" });
              if (!res.ok) throw new Error(`could not download ${filename} (${res.status})`);
              return { filename, data: new Uint8Array(await res.arrayBuffer()) };
            }),
          );
          await post(target, content, uploads);
        }
        return { ok: true };
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "discord post failed" };
      }
    });
