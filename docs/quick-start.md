# Quick start

Run the whole loop on your machine: the Coordinator (with the Discord bot), a Watcher that works tickets with local Claude Code, and the dashboard. For every setting and permission, see [Setup](../SETUP.md).

```sh
bun install
cp .env.example .env                 # Discord bot + OPENROUTER_API_KEY + ADMIN_*
docker compose up --build            # coordinator :8080 (runs the Discord bot too) + Grafana :3000

# one-time seed (replace with your Discord channel ID)
docker compose exec -e SEED_DISCORD_CHANNEL_ID=<channel-id> coordinator bun run seed

# on the host — start the Watcher (local Claude Code worker)
set -a; . ./.env; set +a
bun apps/watcher/src/main.bun.ts
```

Open the dashboard:

```sh
bun run --cwd apps/web dev
# → http://localhost:5173
```

Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env` (see [SETUP.md](../SETUP.md)). You should see projects, live tickets, Project Memory, and worker health refreshing every few seconds.

Without Docker:

```sh
bun run --cwd apps/coordinator dev
curl http://localhost:8080/health
```

Full setup details → [SETUP.md](../SETUP.md)

## Deploying

**Local (recommended for development)**  
`docker compose up --build` — Coordinator (with the Discord bot) + observability stack.

**Cloudflare target**  
The same core runs on Cloudflare Workers + D1 + KV.  
Deployment is managed by Alchemy:

```sh
bun run deploy
```

Estimated cost for a small team: **~$5–7 / month** on the Workers Paid plan (excluding LLM usage).  
Steps and cost breakdown: [docs/deployment.md](deployment.md).
