// Cloudflare deployment, as code (Alchemy v2, "Infrastructure as Effects").
//
//   bun run deploy                 # stage = $ALCHEMY_STAGE or live_$USER
//   bun run deploy --stage prod    # a named stage; every resource name gets the stage
//   bun run plan  / bun run destroy
//
// Values come from `.env` (or `--env-file`), then the shell. Plain settings bind as
// `plain_text` vars, secrets as `secret_text`. Required secrets fail the deploy when unset;
// anything else unset is simply not bound, so a stage without OAuth clients deploys with
// account linking off (same rule as local).
// See docs/deployment.md.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const COMPATIBILITY_DATE = "2026-10-01";

const GATEWAY_CONTEXT = ".alchemy/gateway-context";
const NOT_IN_IMAGE = new Set([
  "node_modules",
  ".git",
  ".alchemy",
  ".claude",
  ".data",
  "coverage",
  "dist",
]);

/**
 * A clean copy of the repo for the gateway image. `alchemy dev` hashes the whole build context
 * and restarts the container on any change, but skips contexts under `.alchemy/`. Building from
 * "." restarted it whenever Alchemy's own state, a build output or a coverage report was
 * written. The copy leaves out secrets (`.env*`) and build output, so it is also what ships.
 */
const stageGatewayContext = () => {
  const keep = (name: string) =>
    !NOT_IN_IMAGE.has(name) && !name.startsWith(".env") && !name.endsWith(".sqlite");
  rmSync(GATEWAY_CONTEXT, { recursive: true, force: true });
  mkdirSync(GATEWAY_CONTEXT, { recursive: true });
  // One entry at a time: copying "." into its own subdirectory is an error, filter or not.
  for (const entry of readdirSync(".").filter(keep)) {
    cpSync(entry, `${GATEWAY_CONTEXT}/${entry}`, {
      recursive: true,
      filter: (source) => keep(basename(source)),
    });
  }
  return GATEWAY_CONTEXT;
};

/**
 * `alchemy dev` rewrites a loopback host in a container's env to `host.docker.localhost`, but Bun
 * resolves every `*.localhost` name to the container itself, so the gateway could not reach the
 * Coordinator (ECONNREFUSED). Docker Desktop reaches the host as `host.docker.internal`. Linux
 * keeps Alchemy's own tunnel, and a real URL passes through unchanged.
 */
const reachableFromContainer = (url: string) => {
  const parsed = new URL(url);
  if (process.platform !== "linux" && ["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    parsed.hostname = "host.docker.internal";
  }
  return parsed.origin;
};

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
 * MCP_URL, WORKER_CWD, ...) and DISCORD_BOT_TOKEN (read apart, bound only to the gateway) are left out.
 */
const optionalVars = [
  // Where the Coordinator POSTs replies. Set it to run the gateway off-platform; otherwise a
  // DISCORD_BOT_TOKEN deploys it as a Container and the stack sets this itself.
  "DISCORD_SPLIT_GATEWAY_URL",
  "DISCORD_GUILD_ID",
  "DISCORD_PROJECT_CATEGORY_ID",
  "DISCORD_MEMBER_ROLE_IDS",
  "DISCORD_REQUIRE_MENTION",
  "ADMIN_CHANNEL_ID",
  "ADMIN_USER_IDS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  // Better Auth: OAuth callbacks and connect links, and more dashboard operators.
  "PUBLIC_URL",
  "ADMIN_EMAILS",
  "GOOGLE_CLIENT_ID",
  "GITHUB_CLIENT_ID",
  "CLICKUP_CLIENT_ID",
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

/** Secrets the Coordinator refuses to start without: the deploy fails when one is unset. */
const requiredSecrets = ["BETTER_AUTH_SECRET", "COORDINATOR_SERVICE_TOKEN"] as const;

/** Secrets: bound as `secret_text` only when set. */
const optionalSecrets = [
  "OPENROUTER_API_KEY",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "CLICKUP_CLIENT_SECRET",
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
  for (const name of requiredSecrets) {
    env[name] = yield* Config.NonEmptyString(name).pipe(Config.map(Redacted.make));
  }
  for (const name of optionalSecrets) {
    const value = yield* Config.option(Config.Redacted(name));
    if (Option.isSome(value)) env[name] = value.value;
  }
  return env;
});

/** The bot token, read apart from `optionalSecrets` so only the gateway gets it. */
const readBotToken = Config.option(Config.Redacted("DISCORD_BOT_TOKEN")).pipe(
  Effect.map(Option.getOrUndefined),
);

/**
 * `alchemy dev` serves every Worker on 1337 unless told otherwise, so they bump each other to
 * the next free port, and so do parallel worktrees. Each gets its own default here. Override per
 * checkout with the env var; a taken port still falls back to a free one rather than failing.
 */
/** A stage name as a DNS label: `live_joel` -> `live-joel`. */
const hostLabel = (stage: string) =>
  stage
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const readDevPorts = Effect.gen(function* () {
  const port = (name: string, fallback: number) =>
    Config.Number(name).pipe(Config.withDefault(fallback));
  return {
    coordinator: yield* port("COORDINATOR_DEV_PORT", 8787),
    dashboard: yield* port("DASHBOARD_DEV_PORT", 8788),
    gateway: yield* port("DISCORD_GATEWAY_DEV_PORT", 8789),
  };
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
    // Files people attach in Discord, copied here at intake. Kept 90 days; links are minted
    // fresh on each ticket_attachments call, so only old tickets lose their files.
    const assets = yield* Cloudflare.R2.Bucket("ASSETS", {
      lifecycleRules: [
        {
          id: "expire-attachments",
          enabled: true,
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * 24 * 60 * 60 } },
        },
      ],
    });

    const plain = yield* readVars;
    const secrets = yield* readSecrets;
    const devPorts = yield* readDevPorts;

    // Custom domains: with ROOT_DOMAIN set, each service is served at
    // `<service>-<stage>-project-os.<ROOT_DOMAIN>` (api, dashboard, gateway). The zone must
    // already be on this Cloudflare account. Unset: workers.dev URLs, as before.
    const stage = yield* Alchemy.Stage;
    const rootDomain = yield* Config.option(Config.NonEmptyString("ROOT_DOMAIN"));
    const hostFor = (service: "api" | "dashboard" | "gateway") =>
      Option.isSome(rootDomain)
        ? `${service}-${hostLabel(stage)}-project-os.${rootDomain.value}`
        : undefined;
    const hosts = {
      api: hostFor("api"),
      dashboard: hostFor("dashboard"),
      gateway: hostFor("gateway"),
    };
    // The Coordinator is `api`, so its public URL is known up front: an explicit PUBLIC_URL wins.
    if (hosts.api && !plain.PUBLIC_URL) plain.PUBLIC_URL = `https://${hosts.api}`;

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
      ...(hosts.dashboard && { domain: { name: hosts.dashboard } }),
      assets: { notFoundHandling: "single-page-application" },
      dev: { port: devPorts.dashboard },
      memo: {
        include: ["**/*", "../../packages/contracts/src/**"],
        lockfile: true,
      },
    });

    // Discord gateway: a long-lived Bun process in a Cloudflare Container, behind a Worker with
    // no public URL (the reply endpoint can post as the bot). The Coordinator reaches it through
    // a service binding. Deployed only when DISCORD_BOT_TOKEN is set and no off-platform
    // DISCORD_SPLIT_GATEWAY_URL is given. It needs Docker at deploy time to build the image, and
    // PUBLIC_URL (the Coordinator's URL) to forward messages, so it joins on the second deploy.
    const botToken = yield* readBotToken;
    const gateway =
      botToken && publicUrl && !plain.DISCORD_SPLIT_GATEWAY_URL
        ? yield* Cloudflare.Worker("DiscordGateway", {
            main: "./apps/discord-gateway/src/main.cloudflare.ts",
            compatibility: { date: COMPATIBILITY_DATE },
            workersDev: false,
            ...(hosts.gateway && { domain: { name: hosts.gateway } }),
            dev: { port: devPorts.gateway },
            // Cron Trigger: restarts the container after a crash, a stop or a deploy.
            crons: ["* * * * *"],
            env: {
              // The image is a Durable Object-managed Container, attached to the class below.
              // A standalone ("fleet") Container is created before the Worker exists, with no
              // Durable Object, and Cloudflare rejects that on this account ("This account
              // requires a Durable Object binding when creating a default application").
              // `GatewayContainer` starts it (`instance` and env are set in `start()`).
              Gateway: Cloudflare.DurableObject("GatewayContainer", {
                containers: [
                  Cloudflare.Container("GatewayImage", {
                    schedulingPolicy: "durable_object",
                    context: stageGatewayContext(),
                    dockerfile: "apps/discord-gateway/Dockerfile",
                  }),
                ],
              }),
              DISCORD_BOT_TOKEN: botToken,
              COORDINATOR_URL: reachableFromContainer(publicUrl),
              COORDINATOR_SERVICE_TOKEN: secrets.COORDINATOR_SERVICE_TOKEN!,
              ...Object.fromEntries(
                (
                  [
                    "DISCORD_GUILD_ID",
                    "DISCORD_PROJECT_CATEGORY_ID",
                    "ADMIN_CHANNEL_ID",
                    "DISCORD_MEMBER_ROLE_IDS",
                    "ADMIN_USER_IDS",
                  ] as const
                ).flatMap((name) => (plain[name] ? [[name, plain[name]]] : [])),
              ),
            },
          })
        : undefined;

    // Coordinator: Elysia on Workers (CloudflareAdapter) + MCP for Workers to pull tickets.
    const coordinator = yield* Cloudflare.Worker("Coordinator", {
      main: "./apps/coordinator/src/main.cloudflare.ts",
      // The Pi session prompt the sandbox launcher sends is a Markdown file shared with the Watcher.
      rules: [{ type: "Text", globs: ["**/*.md"] }],
      // nodejs_compat is the runtime default for dates from 2026-08-04, and it fills
      // `process.env` from the vars and secrets below, which `@project-os/config` reads.
      compatibility: { date: COMPATIBILITY_DATE },
      dev: { port: devPorts.coordinator },
      ...(hosts.api && { domain: { name: hosts.api } }),
      // WEB_ORIGIN is the dashboard's URL, so the browser may call this API (CORS).
      // PI_AGENT: the `PiAgent` class exported by main.cloudflare.ts, one object per Pi session.
      env: {
        DB: db,
        KV: kv,
        ASSETS: assets,
        PI_AGENT: Cloudflare.DurableObject("PiAgent"),
        ...plain,
        ...secrets,
        // Any non-empty URL turns the in-process bot off; replies go through the binding.
        ...(gateway && {
          DISCORD_GATEWAY: gateway,
          DISCORD_SPLIT_GATEWAY_URL: "http://discord-gateway",
        }),
        WEB_ORIGIN: dashboard.url.as<string>(),
      },
      // Cron Trigger: the health sweep (§5), through the `scheduled` handler.
      crons: ["* * * * *"],
    });

    return {
      coordinatorUrl: coordinator.url.as<string>(),
      dashboardUrl: dashboard.url.as<string>(),
      boundSecrets: Object.keys(secrets).join(",") || "(none)",
    };
  }),
);
