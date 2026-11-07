# project-os

> The open-source control tower for your team's AI agents.  
> Questions land in chat → tickets get cleared → grounded answers return. Engineers stay focused.

[![CI](https://img.shields.io/github/actions/workflow/status/joel611/project-os/ci.yml?branch=main)](https://github.com/joel611/project-os/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-ready-black)](https://modelcontextprotocol.io)

<!-- TODO: Add hero GIF of Discord question → ticket → grounded reply -->

**[Quick Start](#quick-start)** · **[Why](docs/why.md)** · **[Docs](docs/)** · **[Architecture](docs/technical-architecture.md)**

---

## Why project-os?

Most AI agents either interrupt engineers or give ungrounded answers.  
project-os sits in the middle like a control tower:

- **Questions land once** — PMs and clients ask in Discord/email. No more "quick ping" tax on senior engineers.
- **Context stays project-scoped** — Every channel maps to exactly one Project. Memory, sources, and instructions never leak.
- **Work becomes tickets** — The tower opens a Ticket, assigns it, and tracks every status update. Channels only see what the tower chooses to surface.
- **Workers pull, never get pushed** — Local Claude Code (or cloud sandboxes) claim tickets atomically. Two agents never collide.
- **Only the tower talks outside** — Adapters are thin. Workers speak only MCP. The surface that can say the wrong thing to a customer is tiny and centralized.
- **Memory compounds** — Workers can write durable facts to Project Memory, so the next similar question starts with more context.

The full story and design rationale: [docs/why.md](docs/why.md).

---

## Quick Start

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

You should see projects, live tickets, Project Memory, and worker health refreshing every few seconds.

Without Docker:

```sh
bun run --cwd apps/coordinator dev
curl http://localhost:8080/health
```

Full setup details → [SETUP.md](SETUP.md)

---

## How the tower works

```
 Discord / Email                                         Dev's laptop
 ┌─────────────┐   inbound    ┌───────────────────┐   ┌──────────────┐
 │  Adapters   │ ───────────▶ │    Coordinator    │◀──│   Watcher    │
 │ (thin radar)│ ◀─────────── │   (the Tower)     │   │ polls, then  │
 └─────────────┘   replies    │ Project Memory    │   │ starts       │
                              │ Tickets + MCP     │   │ Claude Code  │
                              └───────────────────┘   └──────┬───────┘
                                        ▲   MCP tools        │
                                        └────────────────────┘
                                   claim ticket → work it → write result
```

| Role                | Real-world analogy      | Responsibility                                               |
| ------------------- | ----------------------- | ------------------------------------------------------------ |
| **Coordinator**     | Control Tower           | Owns context, tickets, memory, outbound messages             |
| **Channel Adapter** | Radar / radio           | Thin translator. No business logic.                          |
| **Ticket**          | Flight plan / clearance | Single source of truth for status + results                  |
| **Worker**          | Pilot / aircraft        | Claims one ticket, works it via MCP, never talks to channels |
| **Watcher**         | Ground crew             | Polls for assigned tickets and launches local Claude Code    |
| **Project Memory**  | Flight database         | Durable facts the whole team (and future workers) can read   |

Workers speak **MCP only**. Everything they can do is a tool call: read/append ticket, read/write Project Memory.

---

## Usage example

In a project Discord channel:

```
@agent can we ship SSO by end of month?
```

What happens next:

1. Adapter turns the message into a standard inbound event.
2. Coordinator loads the Project + its Memory, opens a Ticket, marks it `assigned`.
3. Watcher on a developer machine sees the ticket and starts a Claude Code session.
4. The Worker claims the ticket, researches via Project Memory + available sources, writes findings back.
5. Coordinator posts a cited answer in the channel. The engineer never saw a ping.

The next related question already benefits from the updated Project Memory.

---

## Self-hosting & Deployment

**Local (recommended for development)**  
`docker compose up --build` — Coordinator (with the Discord bot) + observability stack.

**Cloudflare target**  
The same core runs on Cloudflare Workers + D1 + KV.  
Deployment is managed by Alchemy:

```sh
bun run deploy
```

Estimated cost for a small team: **~$5–7 / month** on the Workers Paid plan (excluding LLM usage).  
Steps and cost breakdown: [docs/deployment.md](docs/deployment.md).

---

## Project layout

```
apps/
  coordinator/          # Tower — Elysia HTTP + MCP, agent loop (main.bun.ts local, main.cloudflare.ts Workers)
  discord-gateway/      # Split mode only: runs channel-discord as its own process
  watcher/              # Host-run Claude Code launcher
  web/                  # Read-only dashboard (TanStack Start SPA; `build` exports a static site)
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
docs/                   # Product brief + technical architecture
CONTEXT.md              # Precise vocabulary used throughout
```

---

## Development

```sh
bun run check       # format + lint + dependency rules
bun run typecheck
bun run test
bun run test:integration
```

Integration suite and the fake Discord adapter: [TESTING.md](TESTING.md).

---

## Contributing

This is still a focused proof-of-concept of the full loop.  
We welcome issues, discussions, and PRs — especially around:

- Additional channel adapters
- More Worker runtimes beyond local Claude Code, Daytona and Cloudflare Sandbox (boat.dev is next)
- Dashboard UX
- Memory quality / retrieval

See the issues tab and [CONTEXT.md](CONTEXT.md) for the language we use (Project, Ticket, Worker, Claim, etc.).

---

## License

MIT — see [LICENSE](LICENSE).

---

**project-os** — clear the airspace so your team can focus on flying.
