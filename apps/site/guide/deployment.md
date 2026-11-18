# Cloudflare deployment (Alchemy)

`alchemy.run.ts` at the repo root declares the Cloudflare target as an [Alchemy v2](https://alchemy.run) stack: an Effect program that creates, updates, and deletes the resources below. It replaces `apps/coordinator/wrangler.jsonc`. Local Docker Compose (§5.6 of the architecture doc) is unchanged.

| Resource | Alchemy id | What it is |
| --- | --- | --- |
| D1 database | `DB` | App database. Migrations come from `packages/db-sqlite/migrations` and are applied on every deploy. |
| KV namespace | `KV` | Bound to the Coordinator as `KV`. |
| Worker | `Coordinator` | `apps/coordinator/src/main.cloudflare.ts` (Elysia + `CloudflareAdapter`), bound to `DB`, `KV`, vars and secrets. |
| Worker + Container | `DiscordGateway` + `GatewayImage` | The Discord gateway (`apps/discord-gateway`, image from its `Dockerfile`) in a `lite` Container behind a Worker with no public URL. Deployed only when `DISCORD_BOT_TOKEN` and `PUBLIC_URL` are set and `DISCORD_SPLIT_GATEWAY_URL` is not. A Cron Trigger restarts the container if it stops. |
| Worker + static assets | `Dashboard` | Builds `apps/web` and serves `dist/client` with SPA fallback. Static assets only, no Worker code. The browser calls the Coordinator directly at `PUBLIC_URL` (baked into the build as `VITE_COORDINATOR_URL`), and the Coordinator allows the dashboard's origin with CORS (`WEB_ORIGIN`, set by the deploy). |

Cloud resource names get the stage, for example `project-os-prod-db`, so stages never share data.

## Deployment layouts

Discord needs an outbound Gateway WebSocket that stays open for as long as the bot is online. A Cloudflare Worker is a short-lived request handler and cannot hold that socket. That one constraint is why there are two layouts. Everything else about the Coordinator is the same in both.

| | Single process (default) | Split (Cloudflare) |
| --- | --- | --- |
| Infrastructure | One Bun process: local, Docker Compose, or a VM or container you run | Coordinator on Cloudflare Workers, Discord in a separate long-lived Bun process |
| Where Discord runs | Inside the Coordinator (library `packages/channel-discord`, started by `main.bun.ts`) | The `apps/discord-gateway` process (`bun run --cwd apps/discord-gateway start`, or its `Dockerfile`) on a VM, Fly, or a container |
| Discord settings | `DISCORD_BOT_TOKEN` on the Coordinator | `DISCORD_BOT_TOKEN`, `COORDINATOR_URL`, `DISCORD_SPLIT_GATEWAY_PORT` on the Discord process, and `DISCORD_SPLIT_GATEWAY_URL` on the Coordinator |
| Reply endpoint | Loopback, on a free port | The Discord process listens on `0.0.0.0:DISCORD_SPLIT_GATEWAY_PORT` |

**Single process.** The Coordinator starts Discord after it begins listening. The reply endpoint binds `127.0.0.1` because it can post as the bot. Without `DISCORD_BOT_TOKEN`, Discord is skipped and the Coordinator logs that it is off. Add the token and restart. A failed login is logged and the Coordinator keeps running without Discord.

**Split.** Setting `DISCORD_SPLIT_GATEWAY_URL` on the Coordinator turns the in-process bot off, even if `DISCORD_BOT_TOKEN` is also set, and sends replies to that URL. The Discord process forwards messages, slash commands and button clicks to `COORDINATOR_URL`. To self-host the split in containers, set `DISCORD_SPLIT_GATEWAY_URL=http://discord-gateway:8081` in `.env` and run `docker compose --profile split up`.

The split reply endpoint has no authentication. Keep it on a private network or behind a firewall, and never publish its port.

**Split on Cloudflare (the stack does this).** With `DISCORD_BOT_TOKEN` and `PUBLIC_URL` set, `alchemy.run.ts` also deploys the `DiscordGateway` Worker, whose `GatewayContainer` Durable Object (bound as `Gateway`) runs `apps/discord-gateway` in a Container. The Worker has `workersDev: false`, so nothing public reaches the reply endpoint. The Coordinator Worker holds a `DISCORD_GATEWAY` service binding and sends replies through it (`adapterFetch` in `CloudflareLive`); the stack sets `DISCORD_SPLIT_GATEWAY_URL` to a placeholder so the in-process bot stays off. The bot token is bound to the gateway only, never the Coordinator. The container forwards messages to `PUBLIC_URL`, so the gateway joins on the second deploy (see below). Building the image needs Docker on the machine or CI runner that runs the deploy.

## First-time setup

1. Log in once: `bunx alchemy profile edit --add Cloudflare` (OAuth or an API token). In CI, set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` instead.
2. Alchemy keeps state in a small `alchemy-state-store` Worker on the same account (`Cloudflare.state()`), so laptops and CI see the same deploys. The first deploy creates it.
3. Put values in `.env` (or a file passed with `--env-file`). The same keys as `.env.example` apply.

## Commands

```sh
bun run plan    --stage prod   # preview changes
bun run deploy  --stage prod   # apply; prints coordinatorUrl and dashboardUrl
bun run destroy --stage prod   # delete every resource in the stage
bun run dev:cf                 # alchemy dev: same stack on local workerd (miniflare D1/KV)
```

`bun run dev:cf` serves the Coordinator on 8787, the Dashboard on 8788 and the gateway Worker on 8789. Set `COORDINATOR_DEV_PORT`, `DASHBOARD_DEV_PORT` or `DISCORD_GATEWAY_DEV_PORT` to move one, for example in a second worktree. A port that is taken still falls back to the next free one.

Without `--stage`, the stage is `$ALCHEMY_STAGE` or `live_$USER`, which gives each developer a private copy.

## Vars and secrets

Plain settings bind as `plain_text` vars. Secrets bind as `secret_text`, never as plain vars, and are redacted in Alchemy's output and state. The deploy fails when a required secret is unset. Any other key that is unset is not bound at all, so a stage without OAuth clients deploys with account linking off, the same rule as the local target.

- **Required secrets:** `BETTER_AUTH_SECRET`, `COORDINATOR_SERVICE_TOKEN`. The service token is also bound to the `DiscordGateway` container, which forwards messages with it.

- **Vars with defaults:** `DEFAULT_MODEL`, `DECISION_MODEL`, `INTENT_CONFIDENCE_THRESHOLD`, `DISCORD_PROJECT_CHANNEL_AUTO_CREATE`.
- **Vars bound when set:** `DISCORD_SPLIT_GATEWAY_URL`, `DISCORD_GUILD_ID`, `DISCORD_PROJECT_CATEGORY_ID`, `DISCORD_MEMBER_ROLE_IDS`, `DISCORD_REQUIRE_MENTION`, `CHANNEL_DIGEST_QUIET_MIN`, `CHANNEL_DIGEST_MAX_WAIT_MIN`, `CHANNEL_DIGEST_RETENTION_DAYS`, `CHANNEL_DIGEST_MODEL`, `AUDIT_RETENTION_DAYS`, `ADMIN_CHANNEL_ID`, `ADMIN_USER_IDS`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `PUBLIC_URL`, `ADMIN_EMAILS`, `GOOGLE_ALLOWED_DOMAINS`, `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`, `CLICKUP_CLIENT_ID`, `SHARED_WORKER_MAX_TICKETS`, `WATCHER_INSTALL_COMMAND`, `WORKER_PROVIDERS`, `SANDBOX_MCP_URL`, `SANDBOX_PI_MODEL`, `SANDBOX_SESSION_TIMEOUT_SECONDS`, `SANDBOX_CREDENTIAL_PROXY`, `SANDBOX_EGRESS_URL`, `DAYTONA_API_URL`, `DAYTONA_SNAPSHOT`, `DAYTONA_MAX_CONCURRENT`, `BOAT_API_URL`, `BOAT_SANDBOX_SIZE`, `BOAT_MAX_CONCURRENT`, `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_MAX_CONCURRENT`.
- **Secrets bound when set:** `OPENROUTER_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `CLICKUP_CLIENT_SECRET`, `DAYTONA_API_KEY`, `BOAT_API_KEY`, `CLOUDFLARE_SANDBOX_TOKEN`.
- **Not bound:** host-only keys (`PORT`, `DATABASE_PATH`, `PI_STORAGE_PATH`, `SEED_*`, `MCP_URL`, `POLL_INTERVAL_MS`, `MAX_SESSIONS`, `WORKER_CWD`, `DISCORD_SPLIT_GATEWAY_PORT`, `COORDINATOR_URL`) and `DISCORD_BOT_TOKEN`, which goes to the `DiscordGateway` Worker (as a secret) and not to the Coordinator, since a Worker can't hold the Discord gateway.

**Custom domains.** Set `ROOT_DOMAIN` (a zone on the same Cloudflare account) and each service is attached as `<service>-<stage>-project-os.<ROOT_DOMAIN>`: `api` (Coordinator), `dashboard` and `gateway`. `PUBLIC_URL` then defaults to the `api` host, so the gateway and the dashboard build need no second deploy. Non-DNS characters in the stage become `-` (`live_joel` -> `live-joel`). The `gateway` host serves the unauthenticated reply endpoint, which can post as the bot: put Cloudflare Access (or a WAF rule) in front of it, or leave `ROOT_DOMAIN` unset and keep the gateway private behind the service binding.

The deploy output lists which secrets were bound (`boundSecrets`). For account linking, set `PUBLIC_URL` to the **`coordinatorUrl`** from the first deploy, then deploy again. That second deploy also rebuilds the dashboard with the Coordinator URL, so the dashboard shows data only after it. Register `$PUBLIC_URL/api/auth/callback/<provider>` with Google and GitHub. Do not use `dashboardUrl`: it serves only static files, so callbacks, `/connect/:token` and `/mcp` would not reach the Coordinator.

## Not on Workers

- **Discord:** a Worker can't hold the gateway WebSocket, so Discord runs in a Container behind its own Worker. To run it elsewhere, set `DISCORD_SPLIT_GATEWAY_URL` and the stack skips the Container. See [Deployment layouts](#deployment-layouts).
- **Watcher:** runs on the machine that hosts Claude Code, with `MCP_URL=<coordinatorUrl>/mcp`.

## Known gaps

- **Works on Workers:** the HTTP API (`/inbound`, `/commands`, `/projects`, ...), MCP at `/mcp` (Watchers poll it), dashboard sign-in, and account linking when `PUBLIC_URL` and a Google or GitHub client are set. Data is in D1, short-lived state in KV. Checked in local workerd: `/health`, MCP initialize and auth, a project create and list, and with dummy OAuth credentials `/connect/done` (200) and `/api/auth/callback/google` (handled by Better Auth). Not checked: a real Google or GitHub round trip.
- **Every route but a few needs credentials** (technical-architecture.md §3.1). The dashboard API takes a signed-in operator, `/inbound`, `/commands` and `/prompts/answer` take the service token, and `/mcp` takes a Worker's token. The admin is seeded on the first `/api/auth` request, since a Worker does no I/O at module load. `apps/e2e/src/coordinator-workers-auth.test.ts` checks this in workerd: password sign-in on D1, the guard, the service token, and that the Worker does not start without its two secrets. Google sign-in on Workers is not checked; the Bun integration suite covers it.
- **Attached files go to R2.** `ASSETS` (an R2 bucket with a 90-day delete rule, declared in `alchemy.run.ts`) holds the files people attach in Discord. The Coordinator streams each one in at intake (Discord's CDN only, up to 100 MB) and hands Workers a signed `<PUBLIC_URL>/assets/...` link, so storage stays off until `PUBLIC_URL` is set; the bucket has no public URL. `apps/e2e/src/r2-assets.test.ts` runs the R2 backend in workerd (Miniflare): a download streamed through a `FixedLengthStream`, read back with its type and size, a wrong reported size refused, the byte limit, and the links. `coordinator-workers-auth.test.ts` also boots the Coordinator Worker with an R2 bucket and fetches a stored object through a signed `/assets` link (bytes, type and length), a bad signature (403) and a missing key (404). Not checked: a real R2 bucket on a deployed account, or a real Discord CDN download from a Worker.
- **Pi Durable runs in a Durable Object.** `PiAgent` (`apps/coordinator/src/pi-agent.ts`, SQLite-backed, bound as `PI_AGENT`) owns one Pi Harness per session (`project:<id>`, `admin:<channel>`, `sidekick:<ticket>`); the Worker calls it over RPC. `apps/e2e/src/pi-agent.test.ts` runs it in workerd (Miniflare) with a faux model: per-session history, idempotent `requestId`, an admin tool writing to D1, and a conversation that survives a restart. A real OpenRouter answer and an admin turn through the fake Discord adapter were also checked by hand in `alchemy dev`. Not checked: the Sidekick token callback over RPC, or recovery after the object is evicted mid-turn (the next delivery of the same message resumes it by `requestId`; no alarm is armed). Pi telemetry (OTLP) is off on Workers.
- **Sandbox pool runs on Workers, with a time limit.** `main.cloudflare.ts` builds the same `WorkerLauncher` as the Bun Coordinator (`sandboxLauncherFromEnv`) and holds each sandbox session open with `waitUntil`. In `alchemy dev` a ticket is assigned `daytona_pi` and the Coordinator starts the sandbox. A deployed Worker caps `waitUntil` time, so a long session is cut off there and its sandbox is only reclaimed by the provider's idle timeout; running the session from a Durable Object alarm is the follow-up. A session finishing a ticket was not seen: Daytona sandboxes below Tier 3 cannot reach the public `/mcp` URL (TLS reset while npm works), so Daytona is paused (see [Setup](setup.md)). The wiring is provider-neutral and serves Cloudflare Sandbox and boat.dev too.
- **The gateway Container is not tested end to end.** `apps/e2e/src/discord-gateway.test.ts` runs the real gateway Worker and the Coordinator's service-binding path in workerd, with a Durable Object standing in for the container. `alchemy dev` built the stack with the Container and the service binding. Not checked: the container actually logging in to Discord, and a real reply posted from Cloudflare. The container is a Durable Object-managed Container (`schedulingPolicy: "durable_object"`) started by `GatewayContainer`, one instance because the Worker addresses a single named object, and a cold start after a deploy or crash waits for the next Cron tick (up to a minute) or the next reply.
- **No deploy against a real account yet.** The Worker was bundled and run in local workerd, not deployed.
- `KeyValueStore.setIfAbsent` is not atomic on Workers KV, and a TTL under 60 seconds is raised to 60. Inbound dedupe can let a duplicate delivery through.
- **The health sweep runs from a Cron Trigger** (`crons: ["* * * * *"]`, `scheduled` in `main.cloudflare.ts`), every minute. Why a Cron Trigger and not Durable Object alarms: [ADR 0001](../../../docs/adr/0001-health-sweep-on-cron-not-durable-object-alarms.md).
- Alchemy reads the drizzle-kit v1 layout (one folder per migration) straight from `packages/db-sqlite/migrations`, the same folder the local migrator uses.
- Alchemy v2 is in beta. Versions are pinned exactly (`alchemy`, `@alchemy.run/cloudflare`); expect breaking changes on upgrade.

## Cost

Estimated at about **$5–7 a month** on Cloudflare (Workers Paid plan, prices as of 2026-11). The usage figures are guesses for a small team, not measurements.

| Part              | Cost / month | Why                                                                                                                                                                                                                                                   |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers Paid plan | $5 flat      | Covers the Coordinator, the dashboard, D1, KV and Cron. Cron every minute plus the Watcher polling every 5 minutes is about 52k requests, against 10M included. Static assets are free. D1 includes 25B rows read and 50M rows written.               |
| Discord gateway   | ~$1.70       | The split layout's `apps/discord-gateway` needs an always-on process. The stack runs it as a `lite` Cloudflare Container (256 MiB): memory is about $1.40 and disk about $0.30, and CPU stays inside the included minutes. A small VM elsewhere costs a few dollars, and running it on your own machine costs $0. |
| Watcher           | $0           | Runs on the machine that hosts Claude Code.                                                                                                                                                                                                           |

The Workers free plan ($0) could work, but it caps CPU at 10 ms per request, which Elysia plus MCP will likely exceed sometimes, and it has no Containers.

LLM usage through OpenRouter is the real variable cost. It grows with message volume and is not included above.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).
