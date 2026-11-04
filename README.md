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
docker compose up coordinator
bun apps/watcher/src/main.ts         # watcher runs on the host
```
