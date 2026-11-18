import {
  makeAgentRuntime,
  makeIntentClassifier,
  newModels,
  openLocalStorage,
} from "@project-os/agent-runtime";
import {
  channelDigestConfig,
  env,
  envBool,
  envNumber,
  formatModelRef,
  healthConfig,
  modelConfig,
} from "@project-os/config";
import { dataPath } from "@project-os/config/data";
import { Auth } from "@project-os/auth";
import { DEFAULT_ORG, DrizzleBun, ensureOrg, LocalLive } from "@project-os/infra-local";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createDiscord } from "@project-os/channel-discord";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { createApp, parseOrigins } from "./app.ts";
import { assetBaseUrl } from "./assets/base-url.ts";
import { makeAccess } from "./access.ts";
import { authConfigFromEnv, serviceTokenFromEnv } from "./auth-env.ts";
import { coordinatorConfig } from "./config.ts";
import { channelDigester, startChannelDigest } from "./digest/index.ts";
import { startHealthSweep } from "./health/start.ts";
import { makeLifecycleNotifications } from "./lifecycle.ts";
import { sandboxLauncherFromEnv } from "./sandbox-pool.ts";
import { setupTelemetry } from "./telemetry.ts";

const port = envNumber("PORT", 8080);
const dbPath = dataPath("project-os.sqlite", process.env.DATABASE_PATH ?? process.env.DB_PATH);

const orgId = ensureOrg(dbPath, DEFAULT_ORG);

const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`);
const webOrigins = parseOrigins(process.env.WEB_ORIGIN);

const authLayer = Auth.layer(
  authConfigFromEnv(process.env, { baseURL: publicUrl, webOrigins }),
).pipe(Layer.provide(DrizzleBun(dbPath)));
// One instance for the app and the runtime: both runtimes share this memo map.
const authRuntime = ManagedRuntime.make(authLayer);
const auth = authRuntime.runSync(Auth);
await auth.ready();
const connections = auth.connections;
const serviceToken = serviceTokenFromEnv(process.env);

const models = newModels();
const modelRefs = modelConfig();
if (!models.getModel(modelRefs.default.provider, modelRefs.default.modelId)) {
  throw new Error(`Unknown DEFAULT_MODEL ${formatModelRef(modelRefs.default)}`);
}
const jev = models.getModelOfType(
  "classifier",
  modelRefs.decision.provider,
  modelRefs.decision.modelId,
);
if (!jev) throw new Error(`Unknown DECISION_MODEL ${formatModelRef(modelRefs.decision)}`);

const runAdmin = <A>(effect: Effect.Effect<A, unknown, AdminEnv>): Promise<A> =>
  runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>);

const adminActions = makeAdminActions({
  run: runAdmin,
  orgId,
  autoCreateChannel: envBool("DISCORD_PROJECT_CHANNEL_AUTO_CREATE", true),
});

const otel = setupTelemetry(process.env);
const digestConfig = channelDigestConfig();
const digester = channelDigester(models, modelRefs.channelDigest);

const AiLive = Layer.orDie(
  Layer.mergeAll(
    makeIntentClassifier({ classifier: models, model: jev }),
    makeAgentRuntime({
      storage: await openLocalStorage(dataPath("pi-durable.sqlite", process.env.PI_STORAGE_PATH)),
      models,
      model: modelRefs.default,
      adminActions,
      telemetry: otel?.telemetry,
    }),
    digester,
  ),
);

const workerLauncher = sandboxLauncherFromEnv(process.env, {
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
    Auth.connectionsLayer,
  ).pipe(Layer.provideMerge(authLayer)),
  { memoMap: authRuntime.memoMap },
);

await runtime.runPromise(startHealthSweep(healthConfig()).pipe(Effect.asVoid));
await runtime.runPromise(
  startChannelDigest({ ...digestConfig, everyMs: healthConfig().sweepEveryMs }).pipe(Effect.asVoid),
);

createApp(
  {},
  {
    ...coordinatorConfig({
      env: process.env,
      run: (effect) => runtime.runPromise(effect),
      publicUrl: () => publicUrl,
      admin: adminActions,
      inbound: { channelDigest: true },
    }),
    access: makeAccess({ serviceToken, auth }),
    mcp: runtime,
    auth,
    members: () => auth.members(),
    ...(connections && { connect: connections }),
  },
).listen(port);
const discordReady = discord?.login().catch((err) => {
  console.error("Discord login failed; the Coordinator keeps running without Discord", err);
  throw err;
});
void discordReady?.catch(() => {});
const lifecycle = makeLifecycleNotifications({
  channelId: process.env.ADMIN_CHANNEL_ID,
  run: (effect) => runtime.runPromise(effect),
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
if (!connections) console.log("account linking off: set an OAuth client (GOOGLE_* / GITHUB_*)");
