# project-os

Project-centric AI agent (see `docs/product-brief.md`). A Coordinator receives messages from channels (Discord, email), turns them into Tickets, and Workers (local Claude Code, Pi in a Daytona, Cloudflare or boat.dev sandbox) work those Tickets through MCP tools. Built with Bun, Vite+, Effect, Elysia, and Drizzle; targets Cloudflare Workers + D1 + KV, with a local Bun + SQLite target for the POC (see `docs/technical-architecture.md`).

## Language

**Coordinator**: the single service that owns the agent loop, intent classification, Project Memory, the Ticket lifecycle, the MCP server, and all outbound messages to channels. Only the Coordinator talks to channels or the database.

**Channel Adapter**: a thin process that normalizes an external event (Discord message, email) into the common inbound message shape, forwards it to the Coordinator, and posts replies when the Coordinator tells it to. No business logic.
_Avoid_: bot, integration (alone).

**Project**: the unit of context. Owns sources, custom instructions, memory, and tickets. One Discord channel maps to exactly one Project.

**ProjectSource**: a link between a Project and something external (Discord channel, email address, repo, Drive folder). `(type, external_id)` is unique. Each has an **alias** saying what it is for (unique within the project, e.g. `design-docs`) and an optional description.

**Project Memory**: the durable knowledge of a Project, stored as MemoryEntries. Readable by the Coordinator, Workers (via MCP), and the Web UI.

**Ticket**: the internal work item the Coordinator creates for each piece of work. All status, follow-ups, and results live on it as TicketEvents. Channels only see what the Coordinator chooses to surface.
_Avoid_: task, job.

**Ticket thread**: the channel thread a Ticket's conversation lives in (one each way). On Discord the Coordinator opens it on the message that created the Ticket; everything said there belongs to that Ticket.

**TicketEvent**: one entry in a Ticket's activity log (created, assigned, status_update, comment, follow_up, result, error, system).

**Worker**: an agent session that works exactly one Ticket through MCP tools and never talks to channels. Pulls work: on session start it lists Tickets assigned to it and claims one.
_Avoid_: agent (alone), runner.

**Sidekick**: the Coordinator's in-process helper for tool-only requests: listing Google Drive files, or reading a GitHub repo's status, history, pipelines or releases. Read-only, with no shell and no checkout, and it acts with the requester's own token. A Ticket it answers is assigned to worker id `sidekick` and finishes in the same request. Anything that needs the whole repo pulled, tests run, or a script run goes to a Worker instead.
_Avoid_: bot, helper agent, Worker (it never pulls or claims through MCP).

**Claim**: the atomic `assigned → in_progress` transition a Worker makes on a Ticket. Two Workers can never claim the same Ticket.

**Watcher**: a host-run program that polls the Coordinator every 5 minutes for assigned, unclaimed Tickets and starts a local Claude Code Worker session for each.

**Personal Worker**: a person's own computer, registered with `/register-worker`, running the Watcher. It gets only the Tickets that person starts, and only while it is online; otherwise their Tickets go to the shared Worker (a Sandbox Pool provider, else the shared Watcher). Authenticates to MCP with a Bearer secret.
_Avoid_: private worker, device worker.

**Sandbox Pool**: the cloud sandbox providers the Coordinator may start Workers on (Daytona, Cloudflare Sandbox, boat.dev), in the order set by `WORKER_PROVIDERS`. On assigning a shared Ticket the Coordinator reads the pool and starts the first provider with room under its cap.
_Avoid_: worker pool (the Watchers are not in it), provider list.

**Connection**: a person's linked Google or GitHub account. Workers use the token of the person behind a Ticket's latest message (`user_token`), so the provider's own permissions apply. Made with `/connect`.
_Avoid_: integration, OAuth app.

**Port**: an interface in `packages/core/src/application/ports`, declared as an Effect `Context.Service` (e.g. `TicketRepository`, `KeyValueStore`, `Scheduler`). Core code depends only on ports.

**Provider**: a package (`infra-cloudflare`, `infra-local`, …) that implements every port for one hosting target and exports an Effect `Layer`. Switching provider means switching the Layer in an app's entry file.

**Domain module**: one folder per entity under `packages/core/src/domain/` holding the entity, its rules, and its typed error (`Data.TaggedError`). It contains no Drizzle schema or provider code; the shared SQLite schema lives in `packages/db-sqlite`.
_Avoid_: package, feature, module (alone), so it isn't confused with a workspace package.
