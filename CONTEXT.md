# project-os

Project-centric AI agent (see `docs/product-brief.md`). A Coordinator receives messages from channels (Discord, email), turns them into Tickets, and Workers (local Claude Code, Daytona + Pi) work those Tickets through MCP tools. Built with Bun, Vite+, Effect, Elysia, and Drizzle; targets Cloudflare Workers + D1 + KV, with a local Bun + SQLite target for the POC (see `docs/technical-architecture.md`).

## Language

**Coordinator**: the single service that owns the agent loop, intent classification, Project Memory, the Ticket lifecycle, the MCP server, and all outbound messages to channels. Only the Coordinator talks to channels or the database.

**Channel Adapter**: a thin process that normalizes an external event (Discord message, email) into the common inbound message shape, forwards it to the Coordinator, and posts replies when the Coordinator tells it to. No business logic.
_Avoid_: bot, integration (alone).

**Project**: the unit of context. Owns sources, custom instructions, memory, and tickets. One Discord channel maps to exactly one Project.

**ProjectSource**: a link between a Project and something external (Discord channel, email address, repo, Drive folder). `(type, external_id)` is unique.

**Project Memory**: the durable knowledge of a Project, stored as MemoryEntries. Readable by the Coordinator, Workers (via MCP), and the Web UI.

**Ticket**: the internal work item the Coordinator creates for each piece of work. All status, follow-ups, and results live on it as TicketEvents. Channels only see what the Coordinator chooses to surface.
_Avoid_: task, job.

**TicketEvent**: one entry in a Ticket's activity log (created, assigned, status_update, comment, follow_up, result, error, system).

**Worker**: an agent session that works exactly one Ticket through MCP tools and never talks to channels. Pulls work: on session start it lists Tickets assigned to it and claims one.
_Avoid_: agent (alone), runner.

**Claim**: the atomic `assigned → in_progress` transition a Worker makes on a Ticket. Two Workers can never claim the same Ticket.

**Watcher**: a host-run program that polls the Coordinator every 5 minutes for assigned, unclaimed Tickets and starts a local Claude Code Worker session for each.

**Port**: an interface in `packages/core/src/application/ports`, declared as an Effect `Context.Service` (e.g. `TicketRepository`, `KeyValueStore`, `Scheduler`). Core code depends only on ports.

**Provider**: a package (`infra-cloudflare`, `infra-local`, …) that implements every port for one hosting target and exports an Effect `Layer`. Switching provider means switching the Layer in an app's entry file.

**Domain module**: one folder per entity under `packages/core/src/domain/` holding the entity, its rules, and its typed error (`Data.TaggedError`). It contains no Drizzle schema or provider code; the shared SQLite schema lives in `packages/db-sqlite`.
_Avoid_: package, feature, module (alone), so it isn't confused with a workspace package.
