import type { InboundMessage } from "@project-os/contracts";
import { type DiscordMessageLike, normalizeMessage } from "./normalize.ts";

export interface FakeSpeaker {
  channelId: string;
  /** Set to speak inside a thread of `channelId`. */
  threadId?: string;
  userId: string;
  name: string;
}

/**
 * Builds the message a human would produce in Discord and runs it through the real
 * `normalizeMessage`, so thread and sender handling match production.
 */
export const fakeInbound = (
  speaker: FakeSpeaker,
  content: string,
  options: { id?: string; at?: Date } = {},
): InboundMessage | null => {
  const at = options.at ?? new Date();
  const message: DiscordMessageLike = {
    id: options.id ?? `fake-${at.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    content,
    createdAt: at,
    author: { id: speaker.userId, username: speaker.name, bot: false },
    member: { displayName: speaker.name },
    channelId: speaker.threadId ?? speaker.channelId,
    channel: speaker.threadId
      ? { isThread: () => true, parentId: speaker.channelId }
      : { isThread: () => false },
  };
  return normalizeMessage(message);
};
