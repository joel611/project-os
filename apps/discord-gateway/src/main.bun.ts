import { createDiscord } from "@project-os/channel-discord";
import { env, envNumber } from "@project-os/config";

// Discord alone, for a Coordinator that can't hold a Gateway socket (Cloudflare) or when you want
// the two apart. Point that Coordinator's DISCORD_SPLIT_GATEWAY_URL here. A Bun Coordinator hosts
// Discord itself and does not need this process.
const discord = createDiscord({
  token: env("DISCORD_BOT_TOKEN"),
  coordinatorUrl: env("COORDINATOR_URL", "http://localhost:8080"),
  // not PORT: that is the Coordinator's, shared via .env
  replyPort: envNumber("DISCORD_SPLIT_GATEWAY_PORT", 8081),
  replyHost: "0.0.0.0",
});
await discord.login();
