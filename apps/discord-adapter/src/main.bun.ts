import { env, envNumber } from "@project-os/config";
import {
  type ApplicationCommandDataResolvable,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import { answerCommand, COMMAND_DEFINITIONS, normalizeCommand } from "./commands.ts";
import { forwardInbound } from "./forward.ts";
import { normalizeMessage } from "./normalize.ts";
import { createReplyApp } from "./reply.ts";

// Long-running process holding an outbound Discord Gateway WebSocket (§8.5).
// Needs the Message Content privileged intent enabled in the Discord developer portal, and the
// Manage Channels permission in DISCORD_GUILD_ID so new projects get their own channel, and
// Create Public Threads + Send Messages in Threads so each new ticket gets its own thread.
// Invite the bot with the `applications.commands` scope so it can register /project-create.
const coordinatorUrl = env("COORDINATOR_URL", "http://localhost:8080");
const port = envNumber("DISCORD_ADAPTER_PORT", 8081); // not PORT: that is the Coordinator's, shared via .env

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on(Events.MessageCreate, async (message) => {
  // The bot's own id, so the Coordinator can ignore project channel chatter that isn't for it.
  const inbound = normalizeMessage(message, client.user?.id);
  if (!inbound) return;
  try {
    await forwardInbound(coordinatorUrl, inbound, fetch);
  } catch (err) {
    console.error("forward to coordinator failed", err);
  }
});

// Server where project channels are created, and the category they go under (optional).
const guildId = process.env.DISCORD_GUILD_ID;
const categoryId = process.env.DISCORD_PROJECT_CATEGORY_ID;
// Only a hint for whether to answer privately; the Coordinator enforces the admin channel.
const adminChannelId = process.env.ADMIN_CHANNEL_ID || undefined;

// Slash commands (/project-create). Registered on DISCORD_GUILD_ID so they appear at once;
// without it they're registered globally, which Discord can take up to an hour to show.
client.once(Events.ClientReady, async (ready) => {
  const commands = COMMAND_DEFINITIONS as unknown as ApplicationCommandDataResolvable[];
  try {
    const target = guildId
      ? (await ready.guilds.fetch(guildId)).commands
      : ready.application.commands;
    await target.set(commands);
    console.log(`registered slash commands ${guildId ? `in guild ${guildId}` : "globally"}`);
  } catch (err) {
    console.error("slash command registration failed", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = normalizeCommand(interaction);
  if (!command) return;
  try {
    await answerCommand(
      command,
      {
        defer: async (ephemeral) =>
          void (await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {})),
        edit: async (content) => void (await interaction.editReply(content)),
        remove: () => interaction.deleteReply(),
        followUp: async (content, ephemeral) =>
          void (await interaction.followUp({
            content,
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          })),
      },
      { coordinatorUrl, ...(adminChannelId && { adminChannelId }), fetcher: fetch },
    );
  } catch (err) {
    console.error(`/${interaction.commandName} failed`, err);
  }
});

createReplyApp(
  async ({ channelId, threadId }, content) => {
    const channel = await client.channels.fetch(threadId ?? channelId);
    if (!channel?.isSendable()) throw new Error(`channel ${threadId ?? channelId} is not sendable`);
    await channel.send(content);
  },
  async (name) => {
    if (!guildId) throw new Error("DISCORD_GUILD_ID is not set");
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      ...(categoryId ? { parent: categoryId } : {}),
      reason: "Project OS: new project",
    });
    return { channelId: channel.id, name: channel.name };
  },
  async ({ channelId, messageId, name }) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isThread() || channel.isDMBased()) {
      throw new Error(`channel ${channelId} can't hold threads`);
    }
    const message = await channel.messages.fetch(messageId);
    // Discord thread names are 1–100 characters.
    const thread = await message.startThread({ name: name.slice(0, 100) || "Ticket" });
    return { threadId: thread.id };
  },
).listen(port);

await client.login(env("DISCORD_BOT_TOKEN"));
console.log(`discord-adapter ready; forwarding to ${coordinatorUrl}, reply endpoint on :${port}`);
