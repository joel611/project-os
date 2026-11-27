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

## Docker (development only)

Docker Compose is for running project-os while you develop. It is not a supported way to deploy it: for that, see [Deploy to Cloudflare](deployment.md).

```sh
docker compose up --build            # Coordinator :8080 (with the Discord bot), Grafana :3000
```

**Try it in Docker.** `scripts/watcher-vm.sh up` starts the Coordinator and a `watcher-vm` container that stands in for an external VM, and seeds a demo project with tickets. `scripts/watcher-vm.sh register` runs `/register-worker` through `POST /commands` (no Discord) and runs the printed install script line inside the container. The package isn't on npm, so the image links the Watcher from the repo and the script's install step is set to `true`. The image has both `pi` and `codex`, so `register` asks for the agent through `/register-worker agent:`: `WATCHER_VM_AGENT` (default `pi`) and `WATCHER_VM_MODEL`. Pi uses `OPENROUTER_API_KEY` and `SANDBOX_PI_MODEL` (the default model for Pi). For Codex, `up` copies your host `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) into the container at start, so it is never baked into the image and goes away with the container; run `WATCHER_VM_AGENT=codex scripts/watcher-vm.sh register`. The VM reaches the Coordinator at `host.docker.internal:8080` (the script sets `PUBLIC_URL` to that). `scripts/watcher-vm.sh logs` follows the Watcher.

## Docs site

The site is built with [VitePress](https://vitepress.dev) from the Markdown in `apps/site`, laid out by URL (`guide/setup.md` is `/guide/setup`). To edit a page, edit its Markdown file. To add one, create it in `apps/site` and add it to the sidebar in `apps/site/.vitepress/config.ts`. Links to files outside `apps/site` (the glossary, ADRs, source files) go to GitHub. The Pages workflow runs only when `apps/site`, its workflow, or the root `package.json` / `bun.lock` change.

```sh
bun run --cwd apps/site dev     # http://localhost:5173/project-os/
bun run --cwd apps/site build   # fails on dead links
```

Pushes to `main` that touch Markdown or `apps/site` deploy it to GitHub Pages (`.github/workflows/pages.yml`).
