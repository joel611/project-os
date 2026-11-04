# project-os

Ticket-driven project agent: a Coordinator turns channel messages into Tickets, and Workers (local Claude Code via the Watcher) work them through MCP. See `docs/technical-architecture.md`.

## Layout

- `apps/coordinator`: Elysia HTTP + MCP server; `main.bun.ts` (local) and `main.cloudflare.ts` (Workers)
- `apps/discord-adapter`, `apps/email-adapter`: thin channel adapters
- `apps/watcher`: host-run CLI that starts Claude Code per ticket
- `packages/core`: domain + ports (provider-free)
- `packages/contracts`: shared wire types
- `packages/db-sqlite`: Drizzle SQLite schema + repositories (D1 and bun:sqlite)
- `packages/infra-local`, `packages/infra-cloudflare`: provider Layers
- `packages/testing`: in-memory fakes
- `libs/config`: env parsing

## Commands

```sh
bun install
bun run check       # vp check: format + lint (incl. dependency rules)
bun run typecheck
bun run test        # vp test
bun run --cwd apps/coordinator dev   # GET http://localhost:8080/health
cp .env.example .env                 # then fill in DISCORD_BOT_TOKEN, OPENROUTER_API_KEY, ADMIN_*
docker compose up --build            # coordinator (:8080) + discord-adapter (+ email stub)
bun apps/watcher/src/main.bun.ts     # watcher runs on the host
```

## Docker Compose setup

Compose runs the Coordinator and adapters; SQLite and Pi state live in the `coordinator-data` volume (`/data`). The Watcher stays on the host and polls the published Coordinator port.

```sh
# one-time: create the default org, a project, and its default Discord channel
docker compose exec -e SEED_DISCORD_CHANNEL_ID=<channel-id> coordinator bun run seed

# host: run the Watcher with the same WORKER_ID as the Coordinator (default local-claude-1)
set -a; . ./.env; set +a
bun apps/watcher/src/main.bun.ts
```

The Discord bot token is `DISCORD_BOT_TOKEN`. `CHAT_MODEL_ID` is required (Compose defaults it to `anthropic/claude-sonnet-4.5`). The Watcher launches `claude -p` with `--allowedTools "mcp__project-os__*"` so headless sessions may call the Coordinator MCP tools.
