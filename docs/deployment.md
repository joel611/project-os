# Cloudflare deployment (Alchemy)

`alchemy.run.ts` at the repo root declares the Cloudflare target as an [Alchemy v2](https://alchemy.run) stack: an Effect program that creates, updates, and deletes the resources below. It replaces `apps/coordinator/wrangler.jsonc`. Local Docker Compose (§5.6 of the architecture doc) is unchanged.

| Resource | Alchemy id | What it is |
| --- | --- | --- |
| D1 database | `DB` | App database. Migrations come from `packages/db-sqlite/migrations` and are applied on every deploy. |
| KV namespace | `KV` | Bound to the Coordinator as `KV`. |
| Worker | `Coordinator` | `apps/coordinator/src/main.cloudflare.ts` (Elysia + `CloudflareAdapter`), bound to `DB`, `KV`, vars and secrets. |
| Worker + static assets | `Dashboard` | Builds `apps/web` and serves `dist/client` with SPA fallback. `apps/web/worker.ts` forwards `/api/*` to the Coordinator over a service binding (`COORDINATOR`), the same rewrite as the Vite dev proxy. |

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

The split reply endpoint has no authentication. Keep it on a private network or behind a firewall, and never publish its port. Today `main.cloudflare.ts` serves only `/health` (see Known gaps), so the Cloudflare half of the split is not usable end to end yet.

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

Without `--stage`, the stage is `$ALCHEMY_STAGE` or `live_$USER`, which gives each developer a private copy.

## Vars and secrets

Plain settings bind as `plain_text` vars. Secrets bind as `secret_text`, never as plain vars, and are redacted in Alchemy's output and state. A key that is unset is not bound at all, so a stage without OAuth clients deploys with account linking off, the same rule as the local target.

- **Vars with defaults:** `WORKER_ID`, `CHAT_MODEL_PROVIDER`, `CHAT_MODEL_ID`, `JEV_MODEL_ID`, `INTENT_CONFIDENCE_THRESHOLD`, `DISCORD_PROJECT_CHANNEL_AUTO_CREATE`.
- **Vars bound when set:** `DISCORD_SPLIT_GATEWAY_URL`, `ADMIN_CHANNEL_ID`, `ADMIN_USER_IDS`, `PUBLIC_URL`, `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`.
- **Secrets bound when set:** `OPENROUTER_API_KEY`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`.

The deploy output lists which secrets were bound (`boundSecrets`). For account linking, set `PUBLIC_URL` to the URL browsers use for the OAuth callbacks (`$PUBLIC_URL/api/auth/oauth2/callback/<provider>`), usually the dashboard URL from the first deploy, then deploy again.

## Not on Workers

- **Discord:** a Worker can't hold the gateway WebSocket, so Discord runs in a separate process. See [Deployment layouts](#deployment-layouts).
- **Watcher:** runs on the machine that hosts Claude Code, with `MCP_URL=<coordinatorUrl>/mcp`.

## Known gaps

- `main.cloudflare.ts` serves only `/health` until `packages/infra-cloudflare` provides the D1/KV Layer, so the deployed Coordinator does not use its bindings yet.
- Cron Triggers (the health sweep) are left off until `main.cloudflare.ts` exports a `scheduled` handler. Add `crons: ["* * * * *"]` to the Coordinator then.
- Alchemy reads flat `.sql` folders or the drizzle-kit v1 layout. `db-sqlite` uses the v0 layout (`meta/_journal.json`), which the local migrator also needs, so the stack copies just the `.sql` files into `dist/d1-migrations/` on each run.
- Alchemy v2 is in beta. Versions are pinned exactly (`alchemy`, `@alchemy.run/cloudflare`); expect breaking changes on upgrade.

## Cost

Estimated at about **$5–7 a month** on Cloudflare (Workers Paid plan, prices as of 2026-11). The usage figures are guesses for a small team, not measurements.

| Part              | Cost / month | Why                                                                                                                                                                                                                                                   |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers Paid plan | $5 flat      | Covers the Coordinator, the dashboard, D1, KV and Cron. Cron every minute plus the Watcher polling every 5 minutes is about 52k requests, against 10M included. Static assets are free. D1 includes 25B rows read and 50M rows written.               |
| Discord adapter   | ~$1.70       | Needs an always-on process. As a `lite` Cloudflare Container (256 MiB), memory is about $1.40 and disk about $0.30, and CPU stays inside the included minutes. A small VM elsewhere costs a few dollars, and running it on your own machine costs $0. |
| Watcher           | $0           | Runs on the machine that hosts Claude Code.                                                                                                                                                                                                           |

The Workers free plan ($0) could work, but it caps CPU at 10 ms per request, which Elysia plus MCP will likely exceed sometimes, and it has no Containers.

LLM usage through OpenRouter is the real variable cost. It grows with message volume and is not included above.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).
