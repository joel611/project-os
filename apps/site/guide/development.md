# Development

How the repository is laid out and how to check a change. The words used throughout the code and docs are defined in the [glossary](../../../CONTEXT.md).

## Project layout

```
apps/
  coordinator/          # Tower — Elysia HTTP + MCP, agent loop (main.bun.ts local, main.cloudflare.ts Workers)
  discord-gateway/      # Split mode only: runs channel-discord as its own process
  watcher/              # Host-run Claude Code launcher
  web/                  # Read-only dashboard (TanStack Start SPA; `build` exports a static site)
  site/                 # This product site: VitePress config and every page's Markdown
packages/
  channel-discord/      # Discord bot, hosted by the Coordinator
  channel-email/        # Gmail reader for the Email Digest (read-only)
  core/                 # Domain + ports (provider-free)
  agent-runtime/        # Intent classifier + agent loop
  db-sqlite/            # Drizzle schema (SQLite / D1)
  infra-local/          # Local provider Layer
  infra-cloudflare/     # Cloudflare provider Layer
  contracts/            # Shared wire types
  testing/              # In-memory fakes
libs/config/            # Env parsing
alchemy.run.ts          # Cloudflare deployment
docs/                   # Internal docs: ADRs, agent guides, research
CONTEXT.md              # Precise vocabulary used throughout
```

## Checks

```sh
bun run check       # format + lint + dependency rules
bun run typecheck
bun run test
bun run test:integration
```

Integration suite and the fake Discord adapter: [Testing without Discord](testing.md).

## Docs site

The site is built with [VitePress](https://vitepress.dev) from the Markdown in `apps/site`, laid out by URL (`guide/setup.md` is `/guide/setup`). To edit a page, edit its Markdown file. To add one, create it in `apps/site` and add it to the sidebar in `apps/site/.vitepress/config.ts`. Links to files outside `apps/site` (the glossary, ADRs, source files) go to GitHub. The Pages workflow runs only when `apps/site`, its workflow, or the root `package.json` / `bun.lock` change.

```sh
bun run --cwd apps/site dev     # http://localhost:5173/project-os/
bun run --cwd apps/site build   # fails on dead links
```

Pushes to `main` that touch Markdown or `apps/site` deploy it to GitHub Pages (`.github/workflows/pages.yml`).
