import { Schema } from "effect";
import { ReplyInstruction } from "@project-os/contracts";
import { Elysia } from "elysia";

export interface ReplyTarget {
  channelId: string;
  threadId?: string;
}
export type PostToDiscord = (target: ReplyTarget, content: string) => Promise<void>;

const decode = Schema.decodeUnknownOption(ReplyInstruction);

/** Reply endpoint: executes Coordinator reply instructions. No decisions made here. */
export const createReplyApp = (post: PostToDiscord) =>
  new Elysia().post("/reply", async ({ body, set }) => {
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
