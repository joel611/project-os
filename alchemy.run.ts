// Cloudflare deployment, as code (Alchemy v2, "Infrastructure as Effects").
//
//   bun run deploy                 # stage = $ALCHEMY_STAGE or live_$USER
//   bun run deploy --stage prod    # a named stage; every resource name gets the stage
//   bun run plan  / bun run destroy
//
// Values come from `.env` (or `--env-file`), then the shell. Plain settings bind as
// `plain_text` vars, secrets as `secret_text`. Anything unset is simply not bound, so a
// stage without OAuth clients deploys with account linking off (same rule as local).
// See docs/deployment.md.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

const COMPATIBILITY_DATE = "2026-10-01";

/** Plain vars with the same defaults as `.env.example`. */
const vars = {
  CHAT_MODEL_PROVIDER: "openrouter",
  CHAT_MODEL_ID: "anthropic/claude-sonnet-4.5",
  JEV_MODEL_ID: "typesafe/jev-1.14",
  INTENT_CONFIDENCE_THRESHOLD: "0.5",
  DISCORD_PROJECT_CHANNEL_AUTO_CREATE: "true",
} as const;

/**
 * Plain vars with no default: bound only when set. Host-only keys (PORT, DATABASE_PATH,
 * MCP_URL, WORKER_CWD, ...) and DISCORD_BOT_TOKEN (no gateway on Workers) are left out.
 */
const optionalVars = [
  // Where the Coordinator POSTs replies. Discord is a long-running gateway process, so on
  // Workers it runs off-platform (apps/discord-gateway, docs/technical-architecture.md §8).
  "DISCORD_SPLIT_GATEWAY_URL",
  "DISCORD_GUILD_ID",
  "DISCORD_PROJECT_CATEGORY_ID",
  "DISCORD_MEMBER_ROLE_IDS",
  "DISCORD_REQUIRE_MENTION",
  "ADMIN_CHANNEL_ID",
  "ADMIN_USER_IDS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  // Account linking (Better Auth, PR #41): connect links and OAuth callbacks.
  "PUBLIC_URL",
  "GOOGLE_CLIENT_ID",
  "GITHUB_CLIENT_ID",
  // Registered workers and the cloud sandbox pool.
  "SHARED_WORKER_MAX_TICKETS",
  "WATCHER_INSTALL_COMMAND",
  "WORKER_PROVIDERS",
  "SANDBOX_MCP_URL",
  "SANDBOX_PI_MODEL",
  "SANDBOX_SESSION_TIMEOUT_SECONDS",
  "DAYTONA_API_URL",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_MAX_CONCURRENT",
  "BOAT_API_URL",
  "BOAT_SANDBOX_SIZE",
  "BOAT_MAX_CONCURRENT",
  "CLOUDFLARE_SANDBOX_URL",
  "CLOUDFLARE_SANDBOX_MAX_CONCURRENT",
] as const;

/** Secrets: bound as `secret_text` only when set. */
const optionalSecrets = [
  "OPENROUTER_API_KEY",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "DAYTONA_API_KEY",
  "BOAT_API_KEY",
  "CLOUDFLARE_SANDBOX_TOKEN",
] as const;

const readVars = Effect.gen(function* () {
  const env: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(vars)) {
    env[name] = yield* Config.String(name).pipe(Config.withDefault(fallback));
  }
  for (const name of optionalVars) {
    const value = yield* Config.option(Config.NonEmptyString(name));
    if (Option.isSome(value)) env[name] = value.value;
  }
  return env;
});

const readSecrets = Effect.gen(function* () {
  const env: Record<string, Redacted.Redacted<string>> = {};
  for (const name of optionalSecrets) {
    const value = yield* Config.option(Config.Redacted(name));
    if (Option.isSome(value)) env[name] = value.value;
  }
  return env;
});

export default Alchemy.Stack(
  "project-os",
  {
    providers: Cloudflare.providers(),
    // State lives in a Worker on the same Cloudflare account, so CI and laptops share it.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // App database. Same Drizzle migrations as the local SQLite provider; Alchemy applies
    // pending ones on each deploy and tracks them in `__alchemy_migrations`.
    const db = yield* Cloudflare.D1.Database("DB", {
      migrations: "./packages/db-sqlite/migrations",
    });
    const kv = yield* Cloudflare.KV.Namespace("KV");

    const plain = yield* readVars;
    const secrets = yield* readSecrets;

    // Dashboard: the Vite SPA as static assets only, no Worker code. The browser calls the
    // Coordinator directly at PUBLIC_URL (baked in as VITE_COORDINATOR_URL), which allows this
    // origin with CORS. PUBLIC_URL is the Coordinator's own URL, known after the first deploy;
    // until it is set the build falls back to `/api`, which nothing serves here.
    const publicUrl = plain.PUBLIC_URL;
    const dashboard = yield* Cloudflare.Website.StaticSite("Dashboard", {
      cwd: "apps/web",
      // The command is spawned without a shell, so `env` sets the variable. `new URL().origin`
      // also keeps the value free of whitespace and quotes.
      command: publicUrl
        ? `env VITE_COORDINATOR_URL=${new URL(publicUrl).origin} bun run build`
        : "bun run build",
      outdir: "dist/client",
      compatibility: { date: COMPATIBILITY_DATE },
      assets: { notFoundHandling: "single-page-application" },
      memo: {
        include: ["**/*", "../../packages/contracts/src/**"],
        lockfile: true,
      },
    });

    // Coordinator: Elysia on Workers (CloudflareAdapter) + MCP for Workers to pull tickets.
    const coordinator = yield* Cloudflare.Worker("Coordinator", {
      main: "./apps/coordinator/src/main.cloudflare.ts",
      // nodejs_compat is the runtime default for dates from 2026-08-04, and it fills
      // `process.env` from the vars and secrets below, which `@project-os/config` reads.
      compatibility: { date: COMPATIBILITY_DATE },
      // WEB_ORIGIN is the dashboard's URL, so the browser may call this API (CORS).
      // PI_AGENT: the `PiAgent` class exported by main.cloudflare.ts, one object per Pi session.
      env: {
        DB: db,
        KV: kv,
        PI_AGENT: Cloudflare.DurableObject("PiAgent"),
        ...plain,
        ...secrets,
        WEB_ORIGIN: dashboard.url.as<string>(),
      },
      // TODO: add `crons: ["* * * * *"]` (health sweep, §5) once main.cloudflare.ts
      // exports a `scheduled` handler; today it only exports `fetch`.
    });

    return {
      coordinatorUrl: coordinator.url.as<string>(),
      dashboardUrl: dashboard.url.as<string>(),
      boundSecrets: Object.keys(secrets).join(",") || "(none)",
    };
  }),
);
