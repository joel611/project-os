## Integration tests

After changing any app or package, run `bun run test:integration`. It boots every component on localhost ports (Coordinator HTTP + MCP, Discord adapter `/reply`, Watcher, SQLite) and drives Discord message → Ticket → Watcher → Worker → reply. AI providers and discord.js are faked, and any non-localhost `fetch` fails the test. Harness: `apps/e2e/src/stack.ts`. A new component or seam gets a suite in `apps/e2e/src/`.

## Agent skills

### Issue tracker

Issues tracked as GitHub Issues in this repo (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
