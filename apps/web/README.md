# web

Read-only dashboard over the Coordinator HTTP API (docs/technical-architecture.md §6): projects and their sources, tickets with their activity log, project memory, and worker health.

```sh
bun run --cwd apps/web dev     # http://localhost:5173
```

The dev server proxies `/api/*` to the Coordinator at `COORDINATOR_URL` (default `http://localhost:8080`), so the Coordinator needs no CORS. Data refreshes every 3 seconds.

Responses are decoded with the `@project-os/contracts` schemas in `src/api.ts`, so a Coordinator change that breaks the contract shows as an error rather than a wrong screen. Like the adapters, this app may only import `contracts` and `libs/config`.

Not yet: mutations (they wait on Web UI auth, §7) and a production deployment (Compose service or static hosting).
