## Runtime & tooling

- Monorepo: bun workspaces (`packages/*`, `apps/*`) managed by turborepo. Use `bun install`, `bun run <script>`, `bunx <package>` — not npm/yarn/pnpm.
- **Deployed runtime is Cloudflare Workers (with `nodejs_compat`), not Bun's own runtime.** `apps/api` is a Hono Worker; don't reach for `Bun.serve()`, `bun:sqlite`, `Bun.redis`, or other Bun-process-only APIs in `apps/api`/`packages/core` — those don't exist on Workers. Bun is only the local package manager/dev-script runner here.
- `apps/web` is TanStack Start in **SPA mode** (`spa: { enabled: true }` in `vite.config.ts`) — no server loaders or server functions, no dependency on `packages/core`. It talks to `apps/api` purely over HTTP, mounted under the same top-level domain (`/api/*`).
- Test runner is **vitest**, uniformly across every package (not `bun test`).
- `Db`/`Auth` are built **per request** inside Hono middleware from `c.env.DB` (the D1 binding) — there is no module-scope singleton runtime, since `env.DB` only exists inside a request handler on Workers. See `packages/core/src/libs/db/client.ts`, `packages/core/src/libs/auth/auth.ts`, and `docs/adr/0001-plain-drizzle-d1-over-effect-sql-d1.md`.
- `libs/db`/`libs/auth` own no schema themselves — see the "Domain module" convention in `CONTEXT.md`.

## Agent skills

### Issue tracker

Issues tracked as GitHub Issues in this repo (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
