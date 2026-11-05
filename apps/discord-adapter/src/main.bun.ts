import { env, envNumber } from "@project-os/config";
import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { forwardInbound } from "./forward.ts";
import { normalizeMessage } from "./normalize.ts";
import { createReplyApp } from "./reply.ts";

// Long-running process holding an outbound Discord Gateway WebSocket (§8.5).
// Needs the Message Content privileged intent enabled in the Discord developer portal, and the
// Manage Channels permission in DISCORD_GUILD_ID so new projects get their own channel.
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
  const inbound = normalizeMessage(message);
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
).listen(port);

await client.login(env("DISCORD_BOT_TOKEN"));
console.log(`discord-adapter ready; forwarding to ${coordinatorUrl}, reply endpoint on :${port}`);
