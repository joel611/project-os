import type { AdminActions } from "@project-os/agent-runtime";
import { Auth, type AuthSettings } from "@project-os/auth";
import { channelDigestConfig, envBool, healthConfig } from "@project-os/config";
import {
  type AgentRuntime,
  type ChannelDigester,
  type EmailClassifier,
  healthSweep,
  type IntentClassifier,
  recordSandboxRun,
  Scheduler,
  type Sidekick,
  type SkillSource,
  type WorkerLauncher,
} from "@project-os/core";
import type { DrizzleSqlite } from "@project-os/db-sqlite";
import type { LocalLive } from "@project-os/infra-local";
import { makeGithubSkillSource } from "@project-os/infra-local/shared";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeAccess } from "./access.ts";
import { type AdminEnv, makeAdminActions } from "./admin/actions.ts";
import { type AppDeps, createApp, parseOrigins } from "./app.ts";
import { authConfigFromEnv, serviceTokenFromEnv } from "./auth-env.ts";
import { coordinatorConfig } from "./config.ts";
import { digestAndLog } from "./digest/index.ts";
import { emailDigestAndLog, emailDigestEnabled, gmailEmailSource } from "./email/index.ts";
import { heldOpen } from "./held-open.ts";
import { checkPullRequests } from "./pull-requests.ts";
import { configuredRunners, sandboxLauncherFromEnv } from "./sandbox-pool.ts";

/** The core ports a platform provides: all but the AI ones, which `ai` provides or replaces. */
export type PlatformPorts = Layer.Success<ReturnType<typeof LocalLive>>;

/** The ports that call an AI provider. */
export type AiPorts =
  | IntentClassifier
  | ChannelDigester
  | EmailClassifier
  | AgentRuntime
  | Sidekick;

/** Everything that differs between the places a Coordinator runs. */
export interface CoordinatorAdapters {
  /** Every setting the assembly needs is read from here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The Coordinator's public URL. Undefined: not known yet (a first Cloudflare deploy). */
  readonly publicUrl: string | undefined;
  readonly orgId: string;
  /** The app database. Better Auth is built on it. */
  readonly database: Layer.Layer<DrizzleSqlite>;
  /**
   * Storage, scheduler, channel gateway, assets and the other platform ports. Gets what the
   * assembly built from the settings, to hand to the platform's Layer.
   */
  readonly platform: (built: {
    readonly skillSource: typeof SkillSource.Service;
    readonly workerLauncher: typeof WorkerLauncher.Service | undefined;
    /** Signs the download links of attached files. */
    readonly assetSecret: string;
  }) => Layer.Layer<PlatformPorts>;
  /** The AI ports: `piAi` in production. */
  readonly ai: (built: { readonly adminActions: AdminActions }) => Layer.Layer<AiPorts>;
  /** A Worker's `waitUntil`, for work that outlives its request. Omitted: the process stays up. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** Elysia's options, such as the platform's server adapter. */
  readonly server?: Parameters<typeof createApp>[0];
  /** How outside providers are reached. Omitted: the real ones. Tests point these at fakes. */
  readonly providers?: {
    /** Changes the auth settings read from env, such as the OAuth endpoints. */
    readonly auth?: (settings: AuthSettings) => AuthSettings;
    readonly githubFetch?: typeof fetch;
    readonly gmailFetch?: (input: string, init?: RequestInit) => Promise<Response>;
    /** Where attached files are downloaded from, and how large they may be. */
    readonly attachments?: NonNullable<
      NonNullable<NonNullable<AppDeps["http"]>["inbound"]>["attachments"]
    >;
    /** Where the credential proxy forwards, when `SANDBOX_CREDENTIAL_PROXY` turns it on. */
    readonly egress?: NonNullable<AppDeps["credentialProxy"]>;
  };
}

/**
 * The whole Coordinator over one platform's adapters: auth, the runtime, the HTTP and MCP app
 * and the recurring jobs. Synchronous, because a Worker builds its app at module load.
 */
export const assembleCoordinator = (adapters: CoordinatorAdapters) => {
  const { env, publicUrl, waitUntil, providers } = adapters;
  const serviceToken = serviceTokenFromEnv(env);

  const authSettings = authConfigFromEnv(env, {
    ...(publicUrl && { baseURL: publicUrl }),
    webOrigins: parseOrigins(env.WEB_ORIGIN),
  });
  const authLayer = Auth.layer(providers?.auth?.(authSettings) ?? authSettings).pipe(
    Layer.provide(adapters.database),
  );
  // One instance for the app and the runtime: both runtimes share this memo map.
  const authRuntime = ManagedRuntime.make(authLayer);
  const auth = authRuntime.runSync(Auth);
  const { connections, sharedAccounts } = auth;

  const workerLauncher = sandboxLauncherFromEnv(env, {
    log: console.log,
    // `runtime` is built below, before any session can end.
    onSessionEnd: (session) => {
      const kept = runtime.runPromise(recordSandboxRun(session));
      // Held open so the write finishes.
      waitUntil?.(kept.catch(() => undefined));
      return kept;
    },
    ...(waitUntil && {
      runners: Object.fromEntries(
        Object.entries(configuredRunners(env)).map(([provider, runner]) => [
          provider,
          heldOpen(runner, waitUntil),
        ]),
      ),
    }),
  });

  const admin = makeAdminActions({
    run: <A>(effect: Effect.Effect<A, unknown, AdminEnv>): Promise<A> =>
      runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>),
    orgId: adapters.orgId,
    autoCreateChannel: envBool("DISCORD_PROJECT_CHANNEL_AUTO_CREATE", true, env),
  });

  // workerd throws "Illegal invocation" when the global `fetch` is called detached.
  const detached = ((input, init) => fetch(input, init)) as typeof fetch;

  const runtime = ManagedRuntime.make(
    // Later layers win: `ai` replaces the platform's placeholders.
    Layer.mergeAll(
      adapters.platform({
        skillSource: makeGithubSkillSource({
          ...(env.SKILLS_GITHUB_TOKEN && { token: env.SKILLS_GITHUB_TOKEN }),
          getToken: async () => (await sharedAccounts?.accessToken("github"))?.accessToken,
          fetch: providers?.githubFetch ?? detached,
        }),
        workerLauncher,
        // `authConfigFromEnv` above refuses to go on without it.
        assetSecret: env.BETTER_AUTH_SECRET!,
      }),
      adapters.ai({ adminActions: admin }),
      Auth.connectionsLayer,
    ).pipe(
      // Reads mail with each person's own Google link, so it is built on the connections above.
      (base) =>
        gmailEmailSource({ fetch: providers?.gmailFetch ?? detached }).pipe(
          Layer.provideMerge(base),
        ),
      Layer.provideMerge(authLayer),
    ),
    { memoMap: authRuntime.memoMap },
  );

  const emailDigest = emailDigestEnabled(env);
  const config = coordinatorConfig({
    env,
    run: (effect) => runtime.runPromise(effect),
    publicUrl: publicUrl ?? "",
    admin,
    inbound: {
      channelDigest: true,
      ...(providers?.attachments && { attachments: providers.attachments }),
    },
  });
  const app = createApp(adapters.server ?? {}, {
    ...config,
    ...(config.credentialProxy && {
      credentialProxy: { ...config.credentialProxy, ...providers?.egress },
    }),
    access: makeAccess({ serviceToken, auth }),
    mcp: runtime,
    auth,
    members: () => auth.members(),
    setRole: (userId, role) => auth.setRole(userId, role),
    ...(sharedAccounts && { sharedAccounts }),
    ...(connections && { connect: connections }),
    emailDigest,
  });

  type Services = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;
  const job = <E>(
    name: "health-sweep" | "channel-digest" | "email-digest" | "pull-requests",
    effect: Effect.Effect<unknown, E, Services>,
  ) => ({ name, effect: Effect.asVoid(effect) });
  const health = healthConfig(env);
  let checkingPullRequests = false;
  const pullRequests = Effect.suspend(() => {
    if (checkingPullRequests) return Effect.void;
    checkingPullRequests = true;
    return checkPullRequests({ fetch: providers?.githubFetch ?? detached }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          checkingPullRequests = false;
        }),
      ),
    );
  });
  const scheduled = [
    job("health-sweep", healthSweep(health)),
    // A project is digested only once its chat is quiet.
    job("channel-digest", digestAndLog(channelDigestConfig(env))),
    ...(emailDigest ? [job("email-digest", emailDigestAndLog())] : []),
    job("pull-requests", pullRequests),
  ];

  return {
    app,
    auth,
    runtime,
    /** The admin dialogue's actions, as the agent runtime gets them. */
    admin,
    /**
     * The recurring work. A platform with timers calls `startJobs`; one with an outside clock
     * (the Cron Trigger, ADR 0001) calls each `run` on its tick. `run` rejects when it fails.
     */
    jobs: scheduled.map(({ name, effect }) => ({
      name,
      run: () => runtime.runPromise(effect),
    })),
    /**
     * Runs every job each `HEALTH_SWEEP_EVERY_SEC` on the platform's `Scheduler`, logging a
     * failed run. Resolves to the stop function.
     */
    startJobs: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler;
          const context = yield* Effect.context<Services>();
          const stops = yield* Effect.forEach(scheduled, ({ name, effect }) =>
            scheduler.every(
              name,
              health.sweepEveryMs,
              effect.pipe(
                Effect.provideContext(context),
                Effect.catchCause((cause) =>
                  Effect.logError(`${name.replace("-", " ")} failed`, cause),
                ),
              ),
            ),
          );
          return () => runtime.runPromise(Effect.all(stops, { discard: true }));
        }),
      ),
    /** Releases what the runtimes hold, such as database handles. */
    dispose: async () => {
      await runtime.dispose();
      await authRuntime.dispose();
    },
  };
};
