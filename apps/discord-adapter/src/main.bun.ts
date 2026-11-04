import { env, envNumber } from "@project-os/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { forwardInbound } from "./forward.ts";
import { normalizeMessage } from "./normalize.ts";
import { createReplyApp } from "./reply.ts";

// Long-running process holding an outbound Discord Gateway WebSocket (§8.5).
// Needs the Message Content privileged intent enabled in the Discord developer portal.
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

createReplyApp(async ({ channelId, threadId }, content) => {
  const channel = await client.channels.fetch(threadId ?? channelId);
  if (!channel?.isSendable()) throw new Error(`channel ${threadId ?? channelId} is not sendable`);
  await channel.send(content);
}).listen(port);

await client.login(env("DISCORD_BOT_TOKEN"));
console.log(`discord-adapter ready; forwarding to ${coordinatorUrl}, reply endpoint on :${port}`);
