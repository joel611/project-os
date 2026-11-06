import type { InboundMessage, SlashCommand } from "@project-os/contracts";
import { normalizeCommand } from "./commands.ts";
import { type DiscordMessageLike, normalizeMessage } from "./normalize.ts";

/** User id of the fake bot; `fakeInbound` mentions it like a person typing @bot. */
export const FAKE_BOT_ID = "fake-bot";

export interface FakeSpeaker {
  channelId: string;
  /** Set to speak inside a thread of `channelId`. */
  threadId?: string;
  userId: string;
  name: string;
}

/**
 * Builds the message a human would produce in Discord and runs it through the real
 * `normalizeMessage`, so thread, sender and mention handling match production.
 * The message @mentions the bot unless `mention` is false.
 */
export const fakeInbound = (
  speaker: FakeSpeaker,
  content: string,
  options: { id?: string; at?: Date; mention?: boolean } = {},
): InboundMessage | null => {
  const at = options.at ?? new Date();
  const mention = options.mention ?? true;
  const message: DiscordMessageLike = {
    id: options.id ?? `fake-${at.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    content: mention && content.trim() !== "" ? `<@${FAKE_BOT_ID}> ${content}` : content,
    createdAt: at,
    author: { id: speaker.userId, username: speaker.name, bot: false },
    member: { displayName: speaker.name },
    channelId: speaker.threadId ?? speaker.channelId,
    channel: speaker.threadId
      ? { isThread: () => true, parentId: speaker.channelId }
      : { isThread: () => false },
    mentions: { users: { has: (id) => mention && id === FAKE_BOT_ID } },
  };
  return normalizeMessage(message, FAKE_BOT_ID);
};

/** Builds the slash command interaction a human would run and normalizes it like production. */
export const fakeCommand = (
  speaker: FakeSpeaker,
  commandName: string,
  options: Record<string, string>,
  id = `fake-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): SlashCommand | null =>
  normalizeCommand({
    id,
    commandName,
    channelId: speaker.threadId ?? speaker.channelId,
    channel: speaker.threadId
      ? { isThread: () => true, parentId: speaker.channelId }
      : { isThread: () => false },
    user: { id: speaker.userId, username: speaker.name },
    member: { displayName: speaker.name },
    options: { data: Object.entries(options).map(([name, value]) => ({ name, value })) },
  });
