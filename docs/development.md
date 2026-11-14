# Development

How the repository is laid out and how to check a change. The words used throughout the code and docs are defined in the [glossary](../CONTEXT.md).

## Project layout

```
apps/
  coordinator/          # Tower — Elysia HTTP + MCP, agent loop (main.bun.ts local, main.cloudflare.ts Workers)
  discord-gateway/      # Split mode only: runs channel-discord as its own process
  watcher/              # Host-run Claude Code launcher
  web/                  # Read-only dashboard (TanStack Start SPA; `build` exports a static site)
  site/                 # This product site (VitePress config only; pages are the repo Markdown)
packages/
  channel-discord/      # Discord bot, hosted by the Coordinator
  channel-email/        # Stub
  core/                 # Domain + ports (provider-free)
  agent-runtime/        # Intent classifier + agent loop
  db-sqlite/            # Drizzle schema (SQLite / D1)
  infra-local/          # Local provider Layer
  infra-cloudflare/     # Cloudflare provider Layer
  contracts/            # Shared wire types
  testing/              # In-memory fakes
libs/config/            # Env parsing
alchemy.run.ts          # Cloudflare deployment
docs/                   # Product brief, architecture, and the source of this site
CONTEXT.md              # Precise vocabulary used throughout
```

## Checks

```sh
bun run check       # format + lint + dependency rules
bun run typecheck
bun run test
bun run test:integration
```

Integration suite and the fake Discord adapter: [TESTING.md](../TESTING.md).

## Docs site

The site is built with [VitePress](https://vitepress.dev) from the Markdown files already in the repo: `README.md` is not part of it, but `SETUP.md`, `TESTING.md`, `CONTEXT.md` and `docs/**` are. `apps/site` holds only the config. To edit a page, edit its Markdown file. To add one, create it under `docs/` and add it to the sidebar in `apps/site/.vitepress/config.ts`.

```sh
bun run --cwd apps/site dev     # http://localhost:5173/project-os/
bun run --cwd apps/site build   # fails on dead links
```

Pushes to `main` that touch Markdown or `apps/site` deploy it to GitHub Pages (`.github/workflows/pages.yml`).
