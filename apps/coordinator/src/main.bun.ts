import { makeAgentRuntime, openLocalStorage } from "@project-os/agent-runtime";
import { env, envNumber } from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { DEFAULT_ORG, DrizzleBun, ensureOrg, LocalLive } from "@project-os/infra-local";
import { createDiscord } from "@project-os/channel-discord";
import { assembleCoordinator } from "./assembly.ts";
import { assetBaseUrl } from "./assets/base-url.ts";
import { serviceTokenFromEnv } from "./auth-env.ts";
import { makeLifecycleNotifications } from "./lifecycle.ts";
import { piAi } from "./pi-ai.ts";
import { setupTelemetry } from "./telemetry.ts";

const port = envNumber("PORT", 8080);
const dbPath = dataPath("project-os.sqlite", process.env.DATABASE_PATH ?? process.env.DB_PATH);
const orgId = ensureOrg(dbPath, DEFAULT_ORG);
const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`);

const otel = setupTelemetry(process.env);
const piStorage = await openLocalStorage(
  dataPath("pi-durable.sqlite", process.env.PI_STORAGE_PATH),
);

const remoteGatewayUrl = process.env.DISCORD_SPLIT_GATEWAY_URL;
const discordToken = process.env.DISCORD_BOT_TOKEN;
const discord =
  discordToken && !remoteGatewayUrl
    ? createDiscord({
        token: discordToken,
        coordinator: {
          url: `http://localhost:${port}`,
          token: serviceTokenFromEnv(process.env),
        },
        replyPort: 0,
        replyHost: "127.0.0.1",
      })
    : undefined;
if (discordToken && remoteGatewayUrl) {
  console.log(
    `DISCORD_BOT_TOKEN ignored: DISCORD_SPLIT_GATEWAY_URL is set, replies go to ${remoteGatewayUrl}`,
  );
} else if (!discordToken && !remoteGatewayUrl) {
  console.log("Discord off: set DISCORD_BOT_TOKEN and restart the Coordinator to enable it");
}

const coordinator = assembleCoordinator({
  env: process.env,
  publicUrl,
  orgId,
  database: DrizzleBun(dbPath),
  platform: ({ skillSource, workerLauncher, assetSecret }) =>
    LocalLive({
      dbPath,
      adapterUrls: { discord: discord?.replyUrl ?? remoteGatewayUrl ?? "http://localhost:8081" },
      ...(workerLauncher && { workerLauncher }),
      skillSource,
      assets: {
        dir: dataPath("assets", process.env.ASSET_DIR),
        publicUrl: assetBaseUrl(process.env, publicUrl),
        secret: assetSecret,
      },
    }),
  ai: piAi(process.env, (input) =>
    makeAgentRuntime({ ...input, storage: piStorage, telemetry: otel?.telemetry }),
  ),
});
await coordinator.auth.ready();
await coordinator.startJobs();
coordinator.app.listen(port);
const discordReady = discord?.login().catch((err) => {
  console.error("Discord login failed; the Coordinator keeps running without Discord", err);
  throw err;
});
void discordReady?.catch(() => {});
const lifecycle = makeLifecycleNotifications({
  channelId: process.env.ADMIN_CHANNEL_ID,
  run: (effect) => coordinator.runtime.runPromise(effect),
  ready: discordReady,
  retryStartup: Boolean(remoteGatewayUrl),
});
let shutdown: Promise<void> | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shutdown ??= (async () => {
      await lifecycle.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          otel?.shutdown() ?? Promise.resolve(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("telemetry shutdown timed out")), 3000);
          }),
        ]);
      } catch (error) {
        console.error("Telemetry shutdown failed", error);
      } finally {
        clearTimeout(timer);
        process.exit(0);
      }
    })();
  });
}
console.log(`coordinator listening on :${port} (MCP at /mcp)`);
if (!coordinator.auth.connections)
  console.log("account linking off: set an OAuth client (GOOGLE_* / GITHUB_*)");
