// Cloudflare deployment, as code (Alchemy v2, "Infrastructure as Effects").
//
//   bun run deploy                 # stage = $ALCHEMY_STAGE or live_$USER
//   bun run deploy --stage prod    # a named stage; every resource name gets the stage
//   bun run plan  / bun run destroy
//
// Values come from `.env` (or `--env-file`), then the shell. Every key named in
// `.env.example` is read. Plain settings bind as
// `plain_text` vars, secrets as `secret_text`. Anything unset is simply not bound, so a
// stage without OAuth clients deploys with account linking off (same rule as local).
// See docs/deployment.md.
import { readFileSync } from "node:fs";
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
 * Every other key in `.env.example`, set or commented out (`# KEY=value`), so a new key
 * there is picked up with no edit here. Each is bound only when set.
 */
const exampleKeys = [
  ...new Set(
    readFileSync(new URL(".env.example", import.meta.url), "utf8")
      .split("\n")
      .map((line) => /^(?:#\s?)?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined && !(name in vars)),
  ),
];

/** Credential-looking names bind as `secret_text`; the rest as plain vars. */
const isSecret = (name: string) => /(?:KEY|TOKEN|SECRET)$/.test(name);
const optionalVars = exampleKeys.filter((name) => !isSecret(name));
const optionalSecrets = exampleKeys.filter(isSecret);

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
