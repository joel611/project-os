# project-os

Project-centric AI agent (see `apps/site/product-brief.md`). A Coordinator receives messages from channels (Discord, email), turns them into Tickets, and Workers (local Claude Code, Pi in a Daytona, Cloudflare or boat.dev sandbox) work those Tickets through MCP tools. Built with Bun, Vite+, Effect, Elysia, and Drizzle; targets Cloudflare Workers + D1 + KV, with a local Bun + SQLite target for the POC (see `apps/site/reference/architecture.md`).

## Language

**Coordinator**: the single service that owns the agent loop, intent classification, Project Memory, the Ticket lifecycle, the MCP server, and all outbound messages to channels. Only the Coordinator talks to channels or the database.

**Channel Adapter**: a thin process that normalizes an external event (Discord message, email) into the common inbound message shape, forwards it to the Coordinator, and posts replies when the Coordinator tells it to. No business logic. It calls the Coordinator with the service token, `COORDINATOR_SERVICE_TOKEN`, which nothing else holds.
_Avoid_: bot, integration (alone).

**Project**: the unit of context. Owns sources, custom instructions, memory, and tickets. One Discord channel maps to exactly one Project.

**ProjectSource**: a link between a Project and something external (Discord channel, email address, repo, Drive folder). `(type, external_id)` is unique. Each has an **alias** saying what it is for (unique within the project, e.g. `design-docs`) and an optional description.

**Project Memory**: the durable knowledge of a Project, stored as MemoryEntries. Readable by the Coordinator, Workers (via MCP), and the Web UI.

**Channel Digest**: the Coordinator's scheduled pass (the same per-minute Cron tick as the health sweep) that reads what people said in a Project's Discord channel and its Ticket threads, @mention or not, and saves the decisions and lasting facts in it to Project Memory without anyone asking. The messages wait as ChannelMessages until their conversation goes quiet, and are deleted once digested. Each entry keeps the messages it came from (who, when, a quote, a link), so "why do we…?" has an answer. On per Project by default and silent; both are Project settings in the dashboard.
_Avoid_: summary, transcript (nothing keeps the conversation itself).

**Email Digest**: the Coordinator's read-only pass over a person's Gmail inbox, on the same per-minute Cron tick. Each person switches their own mailbox on in the dashboard, and must choose what it reads: all mail (the inbox) or one Gmail label. New inbox emails are redacted (secrets, codes, card and phone numbers, link query strings, address parts), matched to a Project by the classifier, and filed when it is at least 90% sure: the decisions and lasting facts go to Project Memory with the sender, subject and a redacted quote, and the body is deleted. Less sure emails wait in the dashboard for the person to pick a Project; filing by hand teaches the classifier, which sees those emails as examples next time. It never sends or changes mail.

**Ticket**: the internal work item the Coordinator creates for each piece of work. All status, follow-ups, and results live on it as TicketEvents. Channels only see what the Coordinator chooses to surface.
_Avoid_: task, job.

**Ticket thread**: the channel thread a Ticket's conversation lives in (one each way). On Discord the Coordinator opens it on the message that created the Ticket; everything said there belongs to that Ticket. Each message there is classified with that Ticket as context (title, ask, status, last result). Small talk on a finished Ticket does nothing; clearly different work gets a "New ticket / Part of this ticket" button prompt, and "New ticket" opens one in a new thread linked from the old one. Otherwise it is a follow-up: on a `completed`, `failed` or `blocked` Ticket that reopens it (back to `open`, placed again; a blocked one's Worker ended its session waiting for exactly this); a `cancelled` Ticket stays closed. A button answer on a `blocked` Ticket's prompt resumes it the same way.

**TicketEvent**: one entry in a Ticket's activity log (created, assigned, status_update, comment, follow_up, result, error, system).

**Run**: one agent session on a Ticket, recorded so the ticket can be debugged afterwards. A Watcher pipes the agent's output (Claude Code's structured stream, plain lines for Pi and Codex), masks secrets, and uploads it in numbered chunks to `POST /tickets/:id/runs` with the device's Bearer; a sandbox launcher hands the Coordinator the session's whole output when it ends. A `RunEvent` is a message, tool call, tool result, output line, error or lifecycle note. The transcript is stored as JSONL chunks in file storage (R2 on Cloudflare) and the `ticket_runs` row keeps the summary; the audit log gets `run_started` / `run_finished`. Secrets are masked on the worker (the device secret, credential-looking environment values, token patterns) and again at the Coordinator. Admins see every Run; a requester sees the Runs of Tickets they asked for. Transcripts are deleted after `RUN_LOG_RETENTION_DAYS` (default 30), the summary stays. A Watcher opts out with `--no-run-log` or `WATCHER_RUN_LOG=0`.
_Avoid_: log (alone), transcript (that is the stored part of a Run), session (that is the agent's process).

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

**Ticket lifecycle**: the one Coordinator module (`ticket-lifecycle.ts`) that is told what happened to a Ticket, and by which actor, and owns what follows: the status change, the TicketEvent history, the audit row and the thread notice or reply. Callers never write those themselves, and the actor is always given, never guessed from the Ticket. A completed Ticket gets a composed reply; a Ticket the Sidekick finishes gets the Sidekick's own words. A Worker's own TicketEvents (`ticket_append_event`) are plain history and carry no consequences.
_Avoid_: ticket service, state machine (the transition rules are the Ticket domain module's).

**Placement**: the Coordinator's decision of where a new Ticket runs: a Personal Worker, a Shared Worker, a Sandbox Pool provider, the Sidekick, or nowhere yet (a Queued Ticket). Inbound messages and the health sweep both place Tickets through the one Placement module. It takes the requester as input and stores it on the Ticket, and it keeps capacity honest: it assigns, recounts the load, and if the device or provider is now over its cap this Ticket, the last to take the slot, goes back to the queue (the health sweep then places Queued Tickets oldest first). A launch that fails at kickoff releases its slot and the Ticket goes back to the queue.
_Avoid_: assignment (that is the `assigned` status), scheduling, routing.

**Queued Ticket**: a new Ticket that no Personal Worker, Shared Worker or Sandbox Pool provider had room for. It stays `open` with no worker, its thread is told so, and the health sweep assigns it, oldest first, once one has room.

**Reassign**: an Operator handing a Ticket that is not finished to a registered device (Personal or Shared Worker) from the dashboard, e.g. off a stuck Worker. It goes back to `assigned` for that device's Watcher to claim, and the old Worker loses access to it. Placement never does this by itself; Sandbox sessions are not targets.
_Avoid_: retry, move.

**Sandbox Pool**: the cloud sandbox providers the Coordinator may start Workers on (Daytona, Cloudflare Sandbox, boat.dev), in the order set by `WORKER_PROVIDERS`. Providers are named `daytona`, `cloudflare` and `boat`, and their Workers are `<provider>-<ticketId>` (`daytona-<ticketId>`). When no Personal or Shared Worker takes a Ticket, the Coordinator reads the pool and starts the first provider with room under its cap.
_Avoid_: worker pool (the Watchers are not in it), provider list.

**Sandbox token**: the Bearer token the Coordinator mints when it starts a sandbox session, handed to Pi in its MCP config. It acts as that session's worker id only and expires with the session (the provider's timeout plus 5 minutes). It is what keeps one sandbox out of another's Ticket, since sandbox worker ids are easy to guess.
_Avoid_: worker secret (that is a registered computer's), session token (that is the dashboard's).

**Operator**: a person allowed into the web dashboard: `ADMIN_EMAIL`, signing in with the seeded password, or an email in `ADMIN_EMAILS`, signing in with Google. With `GOOGLE_ALLOWED_DOMAINS` set, anyone with a Google Workspace account at those domains instead of `ADMIN_EMAILS`. Not the same as a Discord admin (`ADMIN_USER_IDS`), who acts in the admin channel. An Operator also has a **Role**.

**Role**: what a dashboard user may do: `admin` or `member`, stored on the Better Auth user and enforced per route as a resource and action (`ticket:update`, `project:create`, ...; the table is `ROLE_GRANTS` in `packages/contracts/src/permissions.ts`). An admin can do everything. A member can read only the Tickets they are involved in. A new Google sign-in starts as a member; the password admin (`ADMIN_EMAIL`) is always an admin; admins change roles on the Members page, and the last admin can't be demoted.
_Avoid_: admin (alone), user.

**Member**: a person on a channel signed in to the web dashboard with the Google account they linked from that channel (`/dashboard`, the same link as `/connect` Google). They see only **My tickets**: the Tickets they asked for or wrote in (a `created` or `follow_up` event of theirs). Not an Operator with the `admin` Role, who sees everything and also gets My tickets when their Google account is linked the same way.
_Avoid_: user (alone), viewer.

**Connection**: a person's linked Google or GitHub account. Workers use the token of the person behind a Ticket's latest message (`user_token`), so the provider's own permissions apply. Made with `/connect`.

**Shared Account**: a team-wide Google, GitHub or ClickUp login an admin links in the dashboard (Members page) with the same OAuth flow as `/connect`, then assigns to a person per provider. A Worker acts with it only when that person never linked the provider themselves: a personal Connection always wins, and an expired one is never swapped for it. Blocked notices say `via shared <provider> account "<label>"`, and the audit log (kind `connection`) records who added, assigned and used it. Its tokens live on an auth user of its own, never a person's.

**Credential Proxy**: the Coordinator's `/egress` route, opt-in with `SANDBOX_CREDENTIAL_PROXY`. A sandbox session calls GitHub, Google or ClickUp through it with its own MCP token, and the Coordinator adds the Connection's token on the way out, so the token never reaches the sandbox or its model. Sandbox sessions then get no `user_token`.
_Avoid_: integration, OAuth app.

**Task type**: a named group of Skills an Operator builds in the dashboard (e.g. "development"), with a description saying what requests it is for and instructions on how the Worker should use its Skills (added to the Worker's system prompt, so an empty box adds nothing). Jev reads the descriptions of the task types that have skills and picks one for a new request (or none); the Ticket records it as `task_type_id`. Task types are org-wide. The ticket page shows which one a Ticket used.
_Avoid_: skill pack, plugin, toolkit.

**Skill**: an agent skill (a folder with a `SKILL.md` and optional files) downloaded from skills.sh into a Task type. skills.sh only lists them; the Coordinator reads the folder from its GitHub repo, and the pinned copy is stored as one zip per skill in file storage (R2 on Cloudflare), with its key and the folder's git tree SHA kept on the skill. Nothing changes until an Operator clicks Update, which fetches the folders whose SHA changed upstream. Before a Ticket starts, its task type's skills go to the Worker: the Coordinator merges the zips and a sandbox session pulls the result from `GET /tickets/:id/skills` with its own token, unzips and installs it for Pi; a Watcher unzips it into a private folder for that one session, and removes it afterwards. Third-party content runs with the Worker's access, so only Operators add skills.
_Avoid_: plugin, extension.

**Port**: an interface in `packages/core/src/application/ports`, declared as an Effect `Context.Service` (e.g. `TicketRepository`, `KeyValueStore`, `Scheduler`). Core code depends only on ports.

**Provider**: a package (`infra-cloudflare`, `infra-local`, …) that implements every port for one hosting target and exports an Effect `Layer`. Switching provider means switching the Layer in an app's entry file.

**Domain module**: one folder per entity under `packages/core/src/domain/` holding the entity, its rules, and its typed error (`Data.TaggedError`). It contains no Drizzle schema or provider code; the shared SQLite schema lives in `packages/db-sqlite`.
_Avoid_: package, feature, module (alone), so it isn't confused with a workspace package.
