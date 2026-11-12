# project-os

Project-centric AI agent (see `docs/product-brief.md`). A Coordinator receives messages from channels (Discord, email), turns them into Tickets, and Workers (local Claude Code, Pi in a Daytona, Cloudflare or boat.dev sandbox) work those Tickets through MCP tools. Built with Bun, Vite+, Effect, Elysia, and Drizzle; targets Cloudflare Workers + D1 + KV, with a local Bun + SQLite target for the POC (see `docs/technical-architecture.md`).

## Language

**Coordinator**: the single service that owns the agent loop, intent classification, Project Memory, the Ticket lifecycle, the MCP server, and all outbound messages to channels. Only the Coordinator talks to channels or the database.

**Channel Adapter**: a thin process that normalizes an external event (Discord message, email) into the common inbound message shape, forwards it to the Coordinator, and posts replies when the Coordinator tells it to. No business logic. It calls the Coordinator with the service token, `COORDINATOR_SERVICE_TOKEN`, which nothing else holds.
_Avoid_: bot, integration (alone).

**Project**: the unit of context. Owns sources, custom instructions, memory, and tickets. One Discord channel maps to exactly one Project.

**ProjectSource**: a link between a Project and something external (Discord channel, email address, repo, Drive folder). `(type, external_id)` is unique. Each has an **alias** saying what it is for (unique within the project, e.g. `design-docs`) and an optional description.

**Project Memory**: the durable knowledge of a Project, stored as MemoryEntries. Readable by the Coordinator, Workers (via MCP), and the Web UI.

**Channel Digest**: the Coordinator's scheduled pass (the same per-minute Cron tick as the health sweep) that reads what people said in a Project's Discord channel and its Ticket threads, @mention or not, and saves the decisions and lasting facts in it to Project Memory without anyone asking. The messages wait as ChannelMessages until their conversation goes quiet, and are deleted once digested. Each entry keeps the messages it came from (who, when, a quote, a link), so "why do we…?" has an answer. On per Project by default and silent; both are Project settings in the dashboard.
_Avoid_: summary, transcript (nothing keeps the conversation itself).

**Ticket**: the internal work item the Coordinator creates for each piece of work. All status, follow-ups, and results live on it as TicketEvents. Channels only see what the Coordinator chooses to surface.
_Avoid_: task, job.

**Ticket thread**: the channel thread a Ticket's conversation lives in (one each way). On Discord the Coordinator opens it on the message that created the Ticket; everything said there belongs to that Ticket.

**TicketEvent**: one entry in a Ticket's activity log (created, assigned, status_update, comment, follow_up, result, error, system).

**Worker**: an agent session that works exactly one Ticket through MCP tools and never talks to channels. Pulls work: on session start it lists Tickets assigned to it and claims one.
_Avoid_: agent (alone), runner.

**Sidekick**: the Coordinator's in-process helper for tool-only requests: listing Google Drive files, or reading a GitHub repo's status, history, pipelines or releases. Read-only, with no shell and no checkout, and it acts with the requester's own token. A Ticket it answers is assigned to worker id `sidekick` and finishes in the same request. Anything that needs the whole repo pulled, tests run, or a script run goes to a Worker instead.
_Avoid_: bot, helper agent, Worker (it never pulls or claims through MCP).

**Claim**: the atomic `assigned → in_progress` transition a Worker makes on a Ticket. Two Workers can never claim the same Ticket.

**Watcher**: a program on a registered computer that polls the Coordinator every 5 minutes for its assigned, unclaimed Tickets and starts a local Claude Code Worker session for each. It runs only after registering with a `/register-worker` code.

**Personal Worker**: a person's own computer, registered with `/register-worker`, running the Watcher. It gets only the Tickets that person starts, and only while it is online; otherwise their Tickets go to a Shared Worker or the Sandbox Pool. Authenticates to MCP with a Bearer secret.
_Avoid_: private worker, device worker.

**Shared Worker**: a computer an admin registered with `/register-worker shared:True` in the admin channel, running the Watcher. It has no owner and takes anyone's Tickets, up to `SHARED_WORKER_MAX_TICKETS` at a time, before the Sandbox Pool is tried. Authenticates to MCP with a Bearer secret, like a Personal Worker.
_Avoid_: host Watcher, hosted worker (the old fixed `WORKER_ID` Watcher no longer exists).

**Placement**: the Coordinator's decision of where a new Ticket runs: a Personal Worker, a Shared Worker, a Sandbox Pool provider, the Sidekick, or nowhere yet (a Queued Ticket). Inbound messages and the health sweep both place Tickets through the one Placement module. It takes the requester as input and stores it on the Ticket, and it keeps capacity honest: it assigns, recounts the load, and if the device or provider is now over its cap this Ticket, the last to take the slot, goes back to the queue (the health sweep then places Queued Tickets oldest first). A launch that fails at kickoff releases its slot and the Ticket goes back to the queue.
_Avoid_: assignment (that is the `assigned` status), scheduling, routing.

**Queued Ticket**: a new Ticket that no Personal Worker, Shared Worker or Sandbox Pool provider had room for. It stays `open` with no worker, its thread is told so, and the health sweep assigns it, oldest first, once one has room.

**Sandbox Pool**: the cloud sandbox providers the Coordinator may start Workers on (Daytona, Cloudflare Sandbox, boat.dev), in the order set by `WORKER_PROVIDERS`. Providers are named `daytona`, `cloudflare` and `boat`, and their Workers are `<provider>-<ticketId>` (`daytona-<ticketId>`). When no Personal or Shared Worker takes a Ticket, the Coordinator reads the pool and starts the first provider with room under its cap.
_Avoid_: worker pool (the Watchers are not in it), provider list.

**Sandbox token**: the Bearer token the Coordinator mints when it starts a sandbox session, handed to Pi in its MCP config. It acts as that session's worker id only and expires with the session (the provider's timeout plus 5 minutes). It is what keeps one sandbox out of another's Ticket, since sandbox worker ids are easy to guess.
_Avoid_: worker secret (that is a registered computer's), session token (that is the dashboard's).

**Operator**: a person allowed into the web dashboard: `ADMIN_EMAIL`, signing in with the seeded password, or an email in `ADMIN_EMAILS`, signing in with Google. With `GOOGLE_ALLOWED_DOMAINS` set, anyone with a Google Workspace account at those domains instead of `ADMIN_EMAILS`. Not the same as a Discord admin (`ADMIN_USER_IDS`), who acts in the admin channel.
_Avoid_: admin (alone), user.

**Connection**: a person's linked Google or GitHub account. Workers use the token of the person behind a Ticket's latest message (`user_token`), so the provider's own permissions apply. Made with `/connect`.
_Avoid_: integration, OAuth app.

**Port**: an interface in `packages/core/src/application/ports`, declared as an Effect `Context.Service` (e.g. `TicketRepository`, `KeyValueStore`, `Scheduler`). Core code depends only on ports.

**Provider**: a package (`infra-cloudflare`, `infra-local`, …) that implements every port for one hosting target and exports an Effect `Layer`. Switching provider means switching the Layer in an app's entry file.

**Domain module**: one folder per entity under `packages/core/src/domain/` holding the entity, its rules, and its typed error (`Data.TaggedError`). It contains no Drizzle schema or provider code; the shared SQLite schema lives in `packages/db-sqlite`.
_Avoid_: package, feature, module (alone), so it isn't confused with a workspace package.
