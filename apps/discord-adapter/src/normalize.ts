import type { InboundMessage } from "@project-os/contracts";

/** Structural subset of discord.js `Message` so tests need no Discord objects. */
export interface DiscordMessageLike {
  id: string;
  content: string;
  createdAt: Date;
  author: { id: string; username: string; bot: boolean };
  member?: { displayName: string } | null;
  channelId: string;
  channel: { isThread(): boolean; parentId?: string | null };
}

/** Normalizes a human Discord message; returns null for bots and empty messages. */
export const normalizeMessage = (m: DiscordMessageLike): InboundMessage | null => {
  if (m.author.bot || m.content.trim() === "") return null;
  const inThread = m.channel.isThread();
  return {
    channelType: "discord",
    externalId: m.id,
    channelId: inThread ? (m.channel.parentId ?? m.channelId) : m.channelId,
    ...(inThread ? { threadId: m.channelId } : {}),
    sender: { id: m.author.id, name: m.member?.displayName ?? m.author.username },
    content: m.content,
    raw: {
      id: m.id,
      content: m.content,
      authorId: m.author.id,
      channelId: m.channelId,
      createdAt: m.createdAt.toISOString(),
    },
    receivedAt: m.createdAt.toISOString(),
  };
};
