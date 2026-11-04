# project-os

**A project-aware AI agent that lives in your team's chat. You ask. It works the ticket. You get a grounded answer, and no engineer gets interrupted.**

## A Tuesday afternoon

Maya is a PM. A client emails: "Can we ship single sign-on by the end of the month?"

Maya doesn't know. The answer lives in three places. The scope is in an email thread from two weeks ago. The estimate is in a Drive doc. The real constraint is in the code, and only Dev knows that part.

So Maya pings Dev. Dev is deep in a bug. He stops, digs up context he already explained last sprint, and types a long reply. Maya forwards a polished version to the client. Tomorrow, a different PM asks Dev a similar question.

Nothing here is broken. It is just slow, and it taxes the people whose time is the most expensive. The knowledge exists. It is scattered across inboxes, chat history, folders, and one person's head, and every question pays the cost of gathering it again.

## The same afternoon, with project-os

Maya types in the project's Discord channel:

> @agent can we ship SSO by end of month?

Here is what happens next.

1. **A thin adapter hears her.** The Discord adapter does nothing clever. It turns the message into a standard shape and hands it to the Coordinator.
2. **The Coordinator knows where it is.** This channel belongs to exactly one **Project**. The Coordinator loads that project's instructions, sources, and **Project Memory** (the durable facts the team has accumulated).
3. **The work becomes a Ticket.** The Coordinator classifies the intent, opens a **Ticket**, and marks it `assigned`. It never pushes work into anyone. It just posts the work on the board.
4. **A Worker picks it up.** On Dev's machine, a small **Watcher** polls the Coordinator. It sees an unclaimed ticket and starts a Claude Code session. That session claims the ticket, reads the project memory, does the research, and writes its findings back onto the ticket. It never talks to Discord.
5. **The Coordinator replies.** It reads the result from the ticket, decides what is worth surfacing, and tells the adapter to post the answer in the channel.

Maya gets a cited answer. Dev never saw a ping. The next time someone asks a related question, the finding is already in Project Memory.

## Why it is built this way

The shape of the system comes from a few choices. Each one removes a way this kind of agent usually goes wrong.

**The Project is the unit of context.** Chat, memory, sources, and instructions all live inside a Project. One Discord channel maps to exactly one Project, so the agent never has to guess whose context it is using.

**The Ticket is the only conversation.** All status, follow-ups, and results live on the ticket, like a real work ticket. The channel only sees what the Coordinator chooses to surface, the same way a client sees curated updates from a PM and not the internal chatter.

**Workers pull, the Coordinator never pushes.** A Worker lists tickets assigned to it and claims one with an atomic `assigned → in_progress` step. Two Workers can never take the same ticket. A Worker can be a local Claude Code on a laptop today and a Daytona sandbox tomorrow. The Coordinator doesn't care.

**Only the Coordinator talks to the outside.** Channels, the database, and every outbound message go through one service. Adapters have no business logic. Workers have no channel access. The surface that can say the wrong thing to a customer is small and in one place.

**Workers speak MCP.** Everything a Worker can do is a tool call: read or append to a ticket, read or write Project Memory. Nothing else.

```
 Discord / Email                                         Dev's laptop
 ┌─────────────┐   inbound    ┌───────────────────┐   ┌──────────────┐
 │  Adapters   │ ───────────▶ │    Coordinator    │◀──│   Watcher    │
 │ (thin, dumb)│ ◀─────────── │ agent loop        │   │ polls, then  │
 └─────────────┘   replies    │ Project Memory    │   │ starts       │
                              │ Tickets + MCP     │   │ Claude Code  │
                              └───────────────────┘   └──────┬───────┘
                                        ▲   MCP tools        │
                                        └────────────────────┘
                                   claim ticket, work it, write result
```

## Where this stands

This repo is a proof of concept of that loop: Discord message in, Ticket created, local Claude Code works it through MCP, reply out. The Coordinator runs locally on Bun and SQLite via Docker Compose, and the code is structured (ports and providers) so the same core can run on Cloudflare Workers with D1.

The full product vision is in [`docs/product-brief.md`](docs/product-brief.md): Gmail classification, Drive sources, cited answers. The design behind the current build is in [`docs/technical-architecture.md`](docs/technical-architecture.md). The vocabulary used above (Project, Ticket, Worker, Claim, Watcher) is defined in [`CONTEXT.md`](CONTEXT.md).

## Try it

```sh
bun install
cp .env.example .env                 # fill in DISCORD_BOT_TOKEN, OPENROUTER_API_KEY, ADMIN_*
docker compose up --build            # coordinator (:8080) + discord-adapter (+ email stub)

# one-time: create the default org, a project, and its default Discord channel
docker compose exec -e SEED_DISCORD_CHANNEL_ID=<channel-id> coordinator bun run seed

# on the host: run the Watcher with the same WORKER_ID as the Coordinator (default local-claude-1)
set -a; . ./.env; set +a
bun apps/watcher/src/main.bun.ts
```

The Watcher launches `claude -p` with `--allowedTools "mcp__project-os__*"`, so headless sessions can call the Coordinator's MCP tools. SQLite and agent state live in the `coordinator-data` volume (`/data`). `CHAT_MODEL_ID` is required; Compose defaults it to `anthropic/claude-sonnet-4.5`.

Without Docker: `bun run --cwd apps/coordinator dev`, then `GET http://localhost:8080/health`.

## Development

```sh
bun run check       # format + lint, including dependency rules
bun run typecheck
bun run test
```

## Layout

- `apps/coordinator`: Elysia HTTP + MCP server; `main.bun.ts` (local) and `main.cloudflare.ts` (Workers)
- `apps/discord-adapter`, `apps/email-adapter`: thin channel adapters
- `apps/watcher`: host-run CLI that starts Claude Code per ticket
- `packages/core`: domain and ports, provider-free
- `packages/contracts`: shared wire types
- `packages/agent-runtime`: the Coordinator's agent loop and intent classifier
- `packages/db-sqlite`: Drizzle SQLite schema and repositories (D1 and bun:sqlite)
- `packages/infra-local`, `packages/infra-cloudflare`: provider Layers
- `packages/testing`: in-memory fakes
- `libs/config`: env parsing
