import { env, envNumber } from "@project-os/config";
import { createDiscord } from "./main.bun.ts";

// Discord alone, for a Coordinator that can't hold a Gateway socket (Cloudflare). Point that
// Coordinator's DISCORD_ADAPTER_URL here. When the Coordinator runs on Bun it hosts Discord
// itself and this file is not needed.
const discord = createDiscord({
  token: env("DISCORD_BOT_TOKEN"),
  coordinatorUrl: env("COORDINATOR_URL", "http://localhost:8080"),
  // not PORT: that is the Coordinator's, shared via .env
  replyPort: envNumber("DISCORD_ADAPTER_PORT", 8081),
  replyHost: "0.0.0.0",
});
await discord.login();
