import {
  JEV_MODEL_ID,
  makeAgentRuntime,
  makeIntentClassifier,
  newModels,
  openLocalStorage,
} from "@project-os/agent-runtime";
import { channelDigestConfig, env, envBool, envNumber, healthConfig } from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { makeAuth } from "@project-os/auth";
import { DEFAULT_ORG, ensureOrg, LocalLive, openLocalDb } from "@project-os/infra-local";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createDiscord } from "@project-os/channel-discord";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp, parseOrigins } from "./app.ts";
import { assetBaseUrl } from "./assets/base-url.ts";
import { makeAccess } from "./access.ts";
import { authConfigFromEnv, serviceTokenFromEnv } from "./auth-env.ts";
import { coordinatorConfig } from "./config.ts";
import { channelDigesterFromEnv, startChannelDigest } from "./digest/index.ts";
import { startHealthSweep } from "./health/start.ts";
import { sandboxLauncherFromEnv } from "./sandbox-pool.ts";
import { setupTelemetry } from "./telemetry.ts";

const port = envNumber("PORT", 8080);
const dbPath = dataPath("project-os.sqlite", process.env.DATABASE_PATH ?? process.env.DB_PATH);

const orgId = ensureOrg(dbPath, DEFAULT_ORG);

const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`);
const webOrigins = parseOrigins(process.env.WEB_ORIGIN);

const auth = makeAuth(
  authConfigFromEnv(process.env, { db: openLocalDb(dbPath).db, baseURL: publicUrl, webOrigins }),
);
await auth.ready();
const connections = auth.connections;
const serviceToken = serviceTokenFromEnv(process.env);

const models = newModels();
const jevModelId = env("JEV_MODEL_ID", JEV_MODEL_ID);
const jev = models.getModelOfType("classifier", "openrouter", jevModelId);
if (!jev) throw new Error(`Unknown classifier model ${jevModelId}`);

const runAdmin = <A>(effect: Effect.Effect<A, unknown, AdminEnv>): Promise<A> =>
  runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>);

const adminActions = makeAdminActions({
  run: runAdmin,
  orgId,
  autoCreateChannel: envBool("DISCORD_PROJECT_CHANNEL_AUTO_CREATE", true),
});

const otel = setupTelemetry(process.env);
const digestConfig = channelDigestConfig();
const digester = digestConfig.enabled ? channelDigesterFromEnv(models, process.env) : undefined;
const digest = { ...digestConfig, enabled: digester !== undefined };

const AiLive = Layer.orDie(
  Layer.mergeAll(
    makeIntentClassifier({ classifier: models, model: jev }),
    makeAgentRuntime({
      storage: await openLocalStorage(dataPath("pi-durable.sqlite", process.env.PI_STORAGE_PATH)),
      models,
      model: { provider: env("CHAT_MODEL_PROVIDER", "openrouter"), modelId: env("CHAT_MODEL_ID") },
      adminActions,
      telemetry: otel?.telemetry,
    }),
    ...(digester ? [digester] : []),
  ),
);

const workerLauncher = sandboxLauncherFromEnv(process.env, {
  prompt: await Bun.file(new URL("../../watcher/prompts/session-start.md", import.meta.url)).text(),
  log: console.log,
});

const remoteGatewayUrl = process.env.DISCORD_SPLIT_GATEWAY_URL;
const discordToken = process.env.DISCORD_BOT_TOKEN;
const discord =
  discordToken && !remoteGatewayUrl
    ? createDiscord({
        token: discordToken,
        coordinator: { url: `http://localhost:${port}`, token: serviceToken },
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

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({
      dbPath,
      adapterUrls: { discord: discord?.replyUrl ?? remoteGatewayUrl ?? "http://localhost:8081" },
      ...(workerLauncher && { workerLauncher }),
      assets: {
        dir: dataPath("assets", process.env.ASSET_DIR),
        publicUrl: assetBaseUrl(process.env, publicUrl),
        secret: process.env.BETTER_AUTH_SECRET!,
      },
    }),
    AiLive,
    ...(connections ? [connections.layer] : []),
  ),
);

await runtime.runPromise(startHealthSweep(healthConfig()).pipe(Effect.asVoid));
if (digest.enabled) {
  await runtime.runPromise(
    startChannelDigest({ ...digest, everyMs: healthConfig().sweepEveryMs }).pipe(Effect.asVoid),
  );
}

createApp(
  {},
  {
    ...coordinatorConfig({
      env: process.env,
      run: (effect) => runtime.runPromise(effect),
      publicUrl: () => publicUrl,
      admin: adminActions,
      inbound: { channelDigest: digest.enabled },
    }),
    access: makeAccess({ serviceToken, auth }),
    mcp: runtime,
    auth,
    ...(connections && { connect: connections }),
  },
).listen(port);
discord?.login().catch((err) => {
  console.error("Discord login failed; the Coordinator keeps running without Discord", err);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (otel?.shutdown() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
console.log(`coordinator listening on :${port} (MCP at /mcp)`);
if (!connections) console.log("account linking off: set an OAuth client (GOOGLE_* / GITHUB_*)");
