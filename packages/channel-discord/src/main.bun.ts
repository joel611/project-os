import {
  type ApplicationCommandDataResolvable,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import { answerCommand, COMMAND_DEFINITIONS, normalizeCommand } from "./commands.ts";
import { type CoordinatorTarget, forwardInbound } from "./forward.ts";
import {
  isAllowedMember,
  NOT_A_MEMBER_MESSAGE,
  type MemberGate,
  parseIds,
  SERVER_ONLY_MESSAGE,
} from "./members.ts";
import { normalizeMessage } from "./normalize.ts";
import { answerPromptClick, normalizePromptClick } from "./prompts.ts";
import { createReplyApp } from "./reply.ts";

export interface DiscordOptions {
  readonly token: string;
  /** Where inbound messages, commands and prompt clicks are POSTed. */
  readonly coordinator: CoordinatorTarget;
  /** Port for the reply endpoint; 0 picks a free one. */
  readonly replyPort: number;
  /** Interface the reply endpoint binds. Loopback unless the Coordinator is on another host. */
  readonly replyHost: string;
}

export interface Discord {
  /** Base URL the Coordinator POSTs `/reply` and friends to. */
  readonly replyUrl: string;
  /** Connects to the Discord Gateway; call once the Coordinator accepts `/inbound`. */
  readonly login: () => Promise<void>;
}

// Holds an outbound Discord Gateway WebSocket (§8.5), hosted by the Coordinator process or run
// alone by apps/discord-gateway when the Coordinator can't hold a socket, e.g. on Cloudflare.
// Needs the Message Content privileged intent enabled in the Discord developer portal, and the
// Manage Channels permission in DISCORD_GUILD_ID so new projects get their own channel, and
// Create Public Threads + Send Messages in Threads so each new ticket gets its own thread, and
// Add Reactions so it can put 👀 on each message it takes in.
// Invite the bot with the `applications.commands` scope so it can register /project-create.
// The reply endpoint starts now; the Gateway only on `login()`, so the Coordinator can be told
// `replyUrl` before it exists and start serving before the first message arrives.
export const createDiscord = ({
  token,
  coordinator,
  replyPort,
  replyHost,
}: DiscordOptions): Discord => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Optional: only people holding one of these roles can trigger the bot. Unset = everyone.
  // Admins (ADMIN_USER_IDS, the Coordinator's admin list) always pass.
  const memberGate: MemberGate = {
    roleIds: parseIds(process.env.DISCORD_MEMBER_ROLE_IDS),
    adminUserIds: parseIds(process.env.ADMIN_USER_IDS),
  };

  client.on(Events.MessageCreate, async (message) => {
    // Server chat only: DMs are ignored (the bot doesn't ask for the DM intent either).
    if (!message.inGuild()) return;
    // Silent, like a missing @mention: people without a member role can talk among themselves.
    if (!message.author.bot && !isAllowedMember(message.author.id, message.member, memberGate))
      return;
    // The bot's own id, so the Coordinator can ignore project channel chatter that isn't for it.
    const inbound = normalizeMessage(message, client.user?.id);
    if (!inbound) return;
    try {
      await forwardInbound(coordinator, inbound, fetch);
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

  // Clicks on a prompt's buttons or select menu: the Coordinator records the answer and says
  // what the message should now read.
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const answer = normalizePromptClick({
      id: interaction.id,
      customId: interaction.customId,
      ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
      channelId: interaction.channelId,
      channel: interaction.channel,
      user: interaction.user,
      member: interaction.member,
    });
    if (!answer) return;
    try {
      // Same gates as slash commands: server only, member role (admins always pass).
      if (!interaction.inGuild()) {
        await interaction.reply({ content: SERVER_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
        return;
      }
      if (!isAllowedMember(interaction.user.id, interaction.member, memberGate)) {
        await interaction.reply({ content: NOT_A_MEMBER_MESSAGE, flags: MessageFlags.Ephemeral });
        return;
      }
      await answerPromptClick(
        answer,
        {
          defer: async () => void (await interaction.deferUpdate()),
          close: async (content) => void (await interaction.editReply({ content, components: [] })),
          whisper: async (content) =>
            void (await interaction.followUp({ content, flags: MessageFlags.Ephemeral })),
        },
        { coordinator, fetcher: fetch },
      );
    } catch (err) {
      console.error(`prompt click ${interaction.customId} failed`, err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = normalizeCommand(interaction);
    if (!command) return;
    try {
      // Server chat only. Commands aren't offered in DMs, but older registrations may linger.
      if (!interaction.inGuild()) {
        await interaction.reply({ content: SERVER_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
        return;
      }
      if (!isAllowedMember(interaction.user.id, interaction.member, memberGate)) {
        await interaction.reply({ content: NOT_A_MEMBER_MESSAGE, flags: MessageFlags.Ephemeral });
        return;
      }
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
        { coordinator, ...(adminChannelId && { adminChannelId }), fetcher: fetch },
      );
    } catch (err) {
      console.error(`/${interaction.commandName} failed`, err);
    }
  });

  const reply = createReplyApp(
    async ({ channelId, threadId }, content) => {
      const channel = await client.channels.fetch(threadId ?? channelId);
      if (!channel?.isSendable())
        throw new Error(`channel ${threadId ?? channelId} is not sendable`);
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
    async ({ channelId, threadId, messageId, emoji }) => {
      const channel = await client.channels.fetch(threadId ?? channelId);
      if (!channel?.isTextBased())
        throw new Error(`channel ${threadId ?? channelId} has no messages`);
      await channel.messages.react(messageId, emoji);
    },
    async ({ channelId, threadId }, { content, components }) => {
      const channel = await client.channels.fetch(threadId ?? channelId);
      if (!channel?.isSendable())
        throw new Error(`channel ${threadId ?? channelId} is not sendable`);
      const message = await channel.send({ content, components });
      return { messageId: message.id };
    },
  ).listen({ port: replyPort, hostname: replyHost });

  const connectHost = replyHost === "0.0.0.0" ? "localhost" : replyHost;
  return {
    replyUrl: `http://${connectHost}:${reply.server?.port}`,
    login: async () => {
      await client.login(token);
      console.log(
        `discord ready; forwarding to ${coordinator.url}, reply endpoint ${replyHost}:${reply.server?.port}`,
      );
    },
  };
};
