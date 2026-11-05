import { Schema } from "effect";
import { CreateChannelInstruction, ReplyInstruction } from "@project-os/contracts";
import { Elysia } from "elysia";

export interface ReplyTarget {
  channelId: string;
  threadId?: string;
}
export type PostToDiscord = (target: ReplyTarget, content: string) => Promise<void>;
/** Creates a text channel; resolves to its id and Discord's final name. */
export type CreateDiscordChannel = (name: string) => Promise<{ channelId: string; name: string }>;

const decode = Schema.decodeUnknownOption(ReplyInstruction);
const decodeCreate = Schema.decodeUnknownOption(CreateChannelInstruction);

/**
 * Coordinator-facing endpoints: `/reply` posts a message, `/channels` creates a channel.
 * Both execute Coordinator instructions; no decisions are made here. Without
 * `createChannel`, `/channels` answers 501.
 */
export const createReplyApp = (post: PostToDiscord, createChannel?: CreateDiscordChannel) =>
  new Elysia()
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
