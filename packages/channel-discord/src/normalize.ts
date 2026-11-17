import type { InboundMessage } from "@project-os/contracts";

/** Structural subset of discord.js `Message` so tests need no Discord objects. */
export interface DiscordMessageLike {
  id: string;
  content: string;
  createdAt: Date;
  author: { id: string; username: string; bot: boolean };
  member?: { displayName: string } | null;
  channelId: string;
  /** Server the message was sent in; null in DMs. */
  guildId?: string | null;
  channel: { isThread(): boolean; parentId?: string | null };
  /**
   * Direct user mentions (not @everyone), plus mentioned roles. Discord gives every bot a managed
   * role named after it, and picking that role from the @ menu sends `<@&roleId>`, not `<@botId>`.
   */
  mentions?: {
    users: { has(id: string): boolean };
    roles?: { values(): Iterable<{ id: string; tags?: { botId?: string | null } | null }> };
  };
  /** discord.js `Collection<Snowflake, Attachment>`; only the values are read. */
  attachments?: {
    values(): Iterable<{
      id: string;
      name?: string | null;
      contentType?: string | null;
      size: number;
      url: string;
    }>;
  };
}

/**
 * Removes `<@id>` / `<@!id>` mentions of `botUserId`, and `<@&id>` mentions of its managed role,
 * so the classifier sees only the ask.
 */
const stripMention = (content: string, botUserId: string, botRoleIds: string[]): string =>
  [...botRoleIds.map((id) => `<@&${id}>`), `<@!?${botUserId}>`]
    .reduce((text, pattern) => text.replace(new RegExp(pattern, "g"), " "), content)
    .replace(/\s+/g, " ")
    .trim();

/** Ids of mentioned roles that are `botUserId`'s own managed role. */
const mentionedBotRoles = (m: DiscordMessageLike, botUserId: string): string[] =>
  [...(m.mentions?.roles?.values() ?? [])]
    .filter((role) => role.tags?.botId === botUserId)
    .map((role) => role.id);

/**
 * Normalizes a human Discord message; returns null for bots and for messages with neither text
 * nor attachments.
 * With `botUserId`, sets `mentionsBot` and strips the bot's mention from the content.
 */
export const normalizeMessage = (
  m: DiscordMessageLike,
  botUserId?: string,
): InboundMessage | null => {
  const attachments = [...(m.attachments?.values() ?? [])].map((a) => ({
    id: a.id,
    filename: a.name ?? a.id,
    contentType: a.contentType ?? null,
    size: a.size,
    url: a.url,
  }));
  if (m.author.bot || (m.content.trim() === "" && attachments.length === 0)) return null;
  const inThread = m.channel.isThread();
  const botRoleIds = botUserId === undefined ? [] : mentionedBotRoles(m, botUserId);
  const mentionsBot =
    botUserId !== undefined &&
    (m.mentions?.users.has(botUserId) === true ||
      botRoleIds.length > 0 ||
      new RegExp(`<@!?${botUserId}>`).test(m.content));
  return {
    channelType: "discord",
    externalId: m.id,
    channelId: inThread ? (m.channel.parentId ?? m.channelId) : m.channelId,
    ...(inThread ? { threadId: m.channelId } : {}),
    sender: { id: m.author.id, name: m.member?.displayName ?? m.author.username },
    content: mentionsBot ? stripMention(m.content, botUserId!, botRoleIds) : m.content,
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(botUserId === undefined ? {} : { mentionsBot }),
    ...(m.guildId
      ? { url: `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.id}` }
      : {}),
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
