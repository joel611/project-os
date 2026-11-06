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
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

const COMPATIBILITY_DATE = "2026-10-01";

/**
 * Alchemy reads flat `.sql` folders or drizzle-kit v1 folders, but db-sqlite uses the
 * drizzle-kit v0 layout (`meta/_journal.json`), which the local Bun provider's migrator
 * also reads. Copy just the `.sql` files into a flat folder for D1 instead of converting.
 * Names are `NNNN_tag.sql`, so lexical order is migration order.
 */
const d1Migrations = () => {
  const from = "packages/db-sqlite/migrations";
  const to = "dist/d1-migrations";
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const file of readdirSync(from).filter((f) => f.endsWith(".sql"))) {
    copyFileSync(`${from}/${file}`, `${to}/${file}`);
  }
  return `./${to}`;
};

/** Plain vars with the same defaults as `.env.example`. */
const vars = {
  WORKER_ID: "local-claude-1",
  CHAT_MODEL_PROVIDER: "openrouter",
  CHAT_MODEL_ID: "anthropic/claude-sonnet-4.5",
  JEV_MODEL_ID: "typesafe/jev-1.14",
  INTENT_CONFIDENCE_THRESHOLD: "0.5",
  DISCORD_PROJECT_CHANNEL_AUTO_CREATE: "true",
} as const;

/** Plain vars with no default: bound only when set. */
const optionalVars = [
  // Where the Coordinator POSTs replies. The Discord adapter is a long-running gateway
  // process, so it runs off Workers (docs/technical-architecture.md §8).
  "DISCORD_ADAPTER_URL",
  "ADMIN_CHANNEL_ID",
  "ADMIN_USER_IDS",
  // Account linking (Better Auth, PR #41): connect links and OAuth callbacks.
  "PUBLIC_URL",
  "GOOGLE_CLIENT_ID",
  "GITHUB_CLIENT_ID",
] as const;

/** Secrets: bound as `secret_text` only when set. */
const optionalSecrets = [
  "OPENROUTER_API_KEY",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
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
    const db = yield* Cloudflare.D1.Database("DB", { migrations: d1Migrations() });
    const kv = yield* Cloudflare.KV.Namespace("KV");

    const plain = yield* readVars;
    const secrets = yield* readSecrets;

    // Coordinator: Elysia on Workers (CloudflareAdapter) + MCP for Workers to pull tickets.
    const coordinator = yield* Cloudflare.Worker("Coordinator", {
      main: "./apps/coordinator/src/main.cloudflare.ts",
      compatibility: { date: COMPATIBILITY_DATE },
      env: { DB: db, KV: kv, ...plain, ...secrets },
      // TODO: add `crons: ["* * * * *"]` (health sweep, §5) once main.cloudflare.ts
      // exports a `scheduled` handler; today it only exports `fetch`.
    });

    // Dashboard: the Vite SPA as static assets. A small Worker forwards `/api/*` to the
    // Coordinator over a service binding, the same rewrite the Vite dev proxy does.
    const dashboard = yield* Cloudflare.Website.StaticSite("Dashboard", {
      cwd: "apps/web",
      command: "bun run build",
      outdir: "dist/client",
      main: "./apps/web/worker.ts",
      compatibility: { date: COMPATIBILITY_DATE },
      assets: {
        runWorkerFirst: ["/api/*"],
        notFoundHandling: "single-page-application",
      },
      env: { COORDINATOR: coordinator },
      memo: {
        include: ["**/*", "../../packages/contracts/src/**"],
        lockfile: true,
      },
    });

    return {
      coordinatorUrl: coordinator.url.as<string>(),
      dashboardUrl: dashboard.url.as<string>(),
      boundSecrets: Object.keys(secrets).join(",") || "(none)",
    };
  }),
);
