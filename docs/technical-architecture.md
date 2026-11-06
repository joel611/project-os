# Project Agent – Technical Architecture (v2.4)

**Status:** Ticket model + MCP Worker interface locked. Pull assignment model chosen. Worker auth deferred (sandbox, no auth concern).  
**Previous:** v2.3 (MCP Worker interface)  
**Last updated:** 2026-11-04

## Table of Contents

- [1. High-Level Architecture](#1-high-level-architecture)
  - [Design Principles](#design-principles)
- [2. Component Responsibilities](#2-component-responsibilities)
  - [2.1 Channel Adapters (Ingress)](#21-channel-adapters-ingress)
  - [2.2 Coordinator Service (Agent Loop + Project Memory + Tickets + MCP)](#22-coordinator-service-agent-loop--project-memory--tickets--mcp)
  - [2.3 Workers](#23-workers)
- [3. Worker Interface (MCP)](#3-worker-interface-mcp)
  - [3.1 Auth stance](#31-auth-stance)
  - [3.1a Assignment model: pull](#31a-assignment-model-pull)
  - [3.2 MCP Server (owned by Coordinator)](#32-mcp-server-owned-by-coordinator)
- [4. Core Data Model](#4-core-data-model)
  - [Org (lightweight)](#org-lightweight)
  - [Project](#project)
  - [ProjectSource](#projectsource)
  - [MemoryEntry](#memoryentry)
  - [Ticket  (the central work item)](#ticket--the-central-work-item)
  - [TicketEvent  (conversation + status log on the ticket)](#ticketevent--conversation--status-log-on-the-ticket)
  - [Worker  (registry + health)](#worker--registry--health)
  - [User](#user)
- [5. Key Runtime Flows](#5-key-runtime-flows)
  - [5.1 Normal Discord message → Ticket](#51-normal-discord-message--ticket)
  - [5.2 Long-running ticket with follow-ups](#52-long-running-ticket-with-follow-ups)
  - [5.3 Email message](#53-email-message)
  - [5.4 Admin configuration (Discord)](#54-admin-configuration-discord)
  - [5.5 Coordinator health checks (ticket time + worker health)](#55-coordinator-health-checks-ticket-time--worker-health)
  - [5.6 POC deployment: local Docker Compose](#56-poc-deployment-local-docker-compose)
  - [5.7 Per-person Google and GitHub access](#57-per-person-google-and-github-access)
- [6. API Surface](#6-api-surface)
  - [For Web UI / Admin (HTTP)](#for-web-ui--admin-http)
  - [For Workers (MCP only)](#for-workers-mcp-only)
  - [Internal (used by agent loop)](#internal-used-by-agent-loop)
- [7. Open / Deferred Items](#7-open--deferred-items)
- [8. Monorepo Layout & Provider Architecture](#8-monorepo-layout--provider-architecture)
  - [8.1 Targets](#81-targets)
  - [8.2 Clean architecture: ports and adapters](#82-clean-architecture-ports-and-adapters)
  - [8.3 Folder structure](#83-folder-structure)
  - [8.4 Dependency rules](#84-dependency-rules)
  - [8.5 Notes and conflicts](#85-notes-and-conflicts)
  - [8.6 Pi Durable + Jev](#86-pi-durable--jev)
- [9. Migration Note](#9-migration-note)

---

## 1. High-Level Architecture

Three main moving parts:

```
┌──────────────────────┐     ┌─────────────────────────────────────────────┐
│  Channel Adapters    │     │         Coordinator Service                 │
│                      │     │                                             │
│  • Discord bot       │────▶│  • Pi Durable agent loop                    │
│  • Email ingestion   │     │  • Jev classifier                           │
│  • Chatbot client    │     │  • Project Memory (data + logic)            │
│                      │     │  • Outbound replies                         │
└──────────────────────┘     │  • Admin conversation handling              │
                             │  • Ticket creation, assignment, orchestration│
                             │  • MCP Server (tools for Workers)           │
                             │                                             │
                             │  APIs:                                      │
                             │  - Web UI (projects, sources, settings)     │
                             │  - MCP (Workers: tickets + project memory)  │
                             └──────────────────────┬──────────────────────┘
                                                    │
                         MCP tools                  │  Coordinator assigns ticket;
                         (ticket + memory)          │  Worker pulls it on session start
                                                    ▼
                             ┌─────────────────────────────────────────────┐
                             │              Workers                        │
                             │  Daytona + Pi  ·  Local Claude Code / Pi    │
                             │  (MCP client, work on tickets)              │
                             └─────────────────────────────────────────────┘
```

### Design Principles

| Principle | Meaning |
|-----------|---------|
| Ticket-driven work | Coordinator creates a **Ticket**, assigns a Worker. All internal communication, status, and results live on that ticket (like a real-world work ticket). |
| Thin Coordinator | Classifies intent, resolves project, creates/assigns tickets, owns all outbound messaging to channels. Can ask Workers for status or post follow-ups on the ticket. |
| Workers pull and execute tickets via MCP | On session start, look for tickets assigned but not yet picked up, claim one, then work it through MCP tools, read/write Project Memory, post status and results **on the ticket**. Never talk to channels directly. |
| Project Memory is the source of truth | Channel → Project mapping, sources, default reply targets, and durable project knowledge. Accessible by Coordinator, Workers (via MCP), and Web UI. |
| Pull assignment | Coordinator only marks a ticket `assigned` (to a worker / worker type). Workers find and claim their work; the Coordinator never pushes into a Worker. |
| No Worker auth (deferred) | Workers run in a sandbox / trusted network; no auth concern for now. Per-ticket scoped tokens are deferred indefinitely. |
| 1:1 Channel → Project | One Discord channel belongs to exactly one project. |
| Admin via conversation + Web UI | Admins configure projects/sources via the dedicated admin Discord channel or the web interface. |

---

## 2. Component Responsibilities

### 2.1 Channel Adapters (Ingress)

Thin adapters only. No business logic.

**Jobs:**
1. Receive external event (Discord message, email, etc.)
2. Normalize into a common inbound message shape
3. Forward to Coordinator
4. When instructed by Coordinator, post a reply to the specified channel

**Common inbound message shape:**

```ts
{
  channelType: "discord" | "email" | "chat",
  externalId: string,          // message id
  channelId: string,           // Discord channel id / email address / conversation id
  threadId?: string,
  sender: {
    id: string,
    name?: string,
    email?: string
  },
  content: string,
  raw: any,
  receivedAt: string
}
```

#### Discord Adapter
- Listens to the Admin channel + all project-bound channels
- Forwards every relevant human message to Coordinator
- Executes reply instructions from Coordinator (post to channel / thread)
- Does **not** decide project ownership or intent

#### Email Adapter
- Receives inbound email (webhook or polling)
- Normalizes to the same message shape (`channelId` = recipient address)
- Forwards to Coordinator
- Does **not** reply directly unless Coordinator explicitly instructs it
- Typical outcome: Coordinator posts a summary to the project’s default Discord channel

---

### 2.2 Coordinator Service (Agent Loop + Project Memory + Tickets + MCP)

Single bounded context that owns:

- Pi Durable agent loop (§8.6)
- Jev intent classifier (§8.6)
- Project Memory data and logic
- **Ticket lifecycle** (create, assign, follow-up, close)
- **MCP Server** exposing tools to Workers
- Outbound messaging to channels
- Admin conversation handling
- APIs for Web UI

**On every inbound message the Coordinator:**

1. Resolves `channelId` → Project (via ProjectSource lookup)
2. Loads project context + sources + memory
3. Runs Jev to classify intent
4. **Creates a Ticket** and assigns it to a Worker
5. Leaves the ticket in `assigned`; the Worker picks it up on its next session start (pull model). No auth token.
6. For long-running work: can post follow-ups or ask status **on the ticket**
7. Reads final result from the ticket
8. Decides reply content + destination (from Project Memory rules)
9. Instructs the relevant Channel Adapter to post the reply

**Ticket = the internal work item** (mirrors a real-world ticket):
- Initial request and context
- Assignment to Worker
- Status updates and progress from Worker
- Coordinator follow-up questions / clarifications
- Intermediate findings
- Final result
- Links to any MemoryEntries created while working the ticket

The channel (Discord / email) only sees what the Coordinator chooses to surface — just like a customer only sees curated updates from a PM, not internal ticket chatter.

**Project channels need an @mention.** In a project's Discord channel, the Coordinator only acts on top-level messages that @mention the bot (a reply to the bot's message counts); other messages are left alone so people can talk among themselves. The adapter sets `InboundMessage.mentionsBot` and strips the mention from the content. Messages inside a thread are handled without a mention, since a thread is already a conversation with the bot, and the admin channel is unchanged. `DISCORD_REQUIRE_MENTION=false` turns the rule off.

**Ticket threads (Discord)**
- A new ticket gets its own thread: the Coordinator asks the Discord adapter to open one on the message that created it (`ChannelGateway.createThread` → the adapter's `/threads`), records it in `ticket_threads`, and posts a short note there. A new request already made inside a thread uses that thread instead.
- Everything said in a ticket's thread is a `follow_up` on that ticket, whatever the classifier says, except a confident `status_question`, which is answered about that ticket alone. Once the ticket is finished, the thread says so and points back to the channel.
- The completion reply goes to the ticket's thread; tickets without one still reply in the project's default response source.
- The bot needs **Create Public Threads** and **Send Messages in Threads**. If Discord refuses, the ticket is created anyway, without a thread.

**Admin channel special behaviour**
- Dedicated Discord channel for configuration
- Admin can create projects, add sources, set default channels, and ask about ticket status
- Creating a project also creates its own Discord channel (via `ChannelGateway.createChannel` → the Discord adapter's `/channels`) and links it as the default reply channel, unless the admin asks to link an existing channel instead, or `DISCORD_PROJECT_CHANNEL_AUTO_CREATE=false` turns it off for the Coordinator. The bot needs **Manage Channels** in `DISCORD_GUILD_ID`; if Discord refuses, the project is still created and the admin is told why
- `/project-create name:<name> [instructions:<text>]` is a Discord slash command for the same action without the LLM. The Discord adapter registers it (on `DISCORD_GUILD_ID`, else globally) and forwards each use as a `SlashCommand` to the Coordinator's `POST /commands`, which runs the admin `create_project` action. The Coordinator only runs it in `ADMIN_CHANNEL_ID` for `ADMIN_USER_IDS`; elsewhere the reply is private (ephemeral) and nothing is created. Discord can't scope a bot's command to one channel, so the command is visible everywhere and refused outside the admin channel
- Coordinator authenticates the speaker as admin and acts accordingly

**Web UI**
- Thin client against the same Coordinator APIs
- View / create / update projects, sources, settings, memory, tickets
- Admin-only for mutation

---

### 2.3 Workers

Execution engines that work **on tickets** via MCP.

**Two supported modes:**

| Mode | Description |
|------|-------------|
| Daytona + Pi | Ephemeral sandbox running Pi. Tool calls happen inside the sandbox; MCP client talks to Coordinator. |
| Local agent via network | Claude Code, Pi, or other agents exposed over the network. Same MCP tools. |

**Session start (pull model):**

Every Worker session begins with a fixed instruction (system prompt / startup hook for local agents, boot script for Daytona):

> On session start, call `ticket_list_assigned` with your `worker_id`. If any ticket is `assigned` but not yet picked up, claim the oldest one with `ticket_claim`, then work it via `ticket_get`, posting progress and results on the ticket. If none, end the session. When the ticket reaches a terminal status (`completed`, `failed`, `cancelled`), end the session.

**Local Watcher (how local Workers get started):**

A small program Joel runs on his own machine. It joins the network, polls for work, and launches local Claude Code.

- Config: Coordinator MCP endpoint, `worker_id` (e.g. `joel-local-claude`), `worker_type = local_claude`, poll interval (default 5 min), max concurrent sessions (default 1), working directory.
- Every 5 minutes: call `ticket_list_assigned` for its `worker_id`.
- If an unpicked ticket exists and fewer than max sessions are running: start a Claude Code session (e.g. `claude -p "<session-start instruction>"`), with the Coordinator MCP server configured.
- The Claude Code session claims the ticket itself (`ticket_claim`) and works it. The watcher does not claim, so all ticket state changes happen through the Worker's MCP calls.
- One session, one ticket: the session ends at the ticket's terminal status, and the watcher picks up the next ticket on a later poll.
- If the claim fails (taken already), the session just ends.
- The watcher has no channel access and no business logic. It only detects work and starts sessions.

Daytona Workers don't need a watcher: the Coordinator starts a sandbox when it assigns a `daytona_pi` ticket, and the sandbox runs the same session-start instruction.

**Workers can (via MCP tools only):**
- Read the assigned Ticket + its events
- Append TicketEvents (status, comment, result, …)
- Update Ticket status / result
- **project_memory_read** / **project_memory_write** (scoped to the ticket’s project)
- **Never** post to Discord, email, or any channel themselves

---

## 3. Worker Interface (MCP)

### 3.1 Auth stance

**No auth.** For the POC everything runs inside one safe network (local Docker Compose, see §5.5), so there is no auth concern. Workers are configured with the MCP endpoint and their `worker_id`, and call tools directly. Per-ticket scoped tokens are deferred; adding them later should not change the tool surface.

### 3.1a Assignment model: pull

- Coordinator creates the ticket and sets `status = assigned` plus `worker_id` (or just `worker_type` if any worker of that type may take it).
- "Assigned but not picked" = `status = assigned` and `started_at` empty.
- Worker, on session start, lists those tickets and claims one. The claim is an atomic `assigned → in_progress` transition, so two Workers cannot take the same ticket.
- **One session, one ticket.** A Worker session claims exactly one ticket and ends when that ticket reaches a terminal status. New work means a new session.
- Coordinator follow-ups are just `follow_up` TicketEvents; the Worker sees them by re-reading the ticket (`ticket_get`). The Coordinator never calls into the Worker.

### 3.2 MCP Server (owned by Coordinator)

Workers talk to Project Memory and Tickets **only** through MCP tools. No direct channel tools are exposed.

**Ticket tools**
- `ticket_list_assigned` — tickets with `status = assigned` for this `worker_id` (or its `worker_type`), oldest first
- `ticket_claim` — atomic `assigned → in_progress`, sets `worker_id` + `started_at`; fails if already claimed
- `ticket_get` — current ticket + recent events
- `worker_heartbeat` — Worker (watcher or session) reports it is alive: `worker_id`, `worker_type`, current `ticket_id` if any
- `ticket_append_event` — status_update | comment | result | error | …
- `ticket_update_status` — open | assigned | in_progress | blocked | completed | failed | cancelled
- `ticket_ask` — ask the people behind a ticket to approve (Approve / Deny) or pick one of 2–25 options. The Coordinator posts it in the ticket's thread with buttons (a select menu past 5 options); the click comes back through the adapter (`POST /prompts/answer`) and lands on the ticket as a `follow_up` event
- `ticket_get_prompt` — a prompt's status and, once clicked, the option picked and by whom

**Account tools**
- `user_token` — OAuth access token (`google` | `github`) of the person behind the ticket's latest message (§5.7)

**Memory tools**
- `project_memory_read` — read project memory / context (pass project_id)
- `project_memory_write` — create MemoryEntry (auto-linked to ticket_id when present)
- `project_memory_search` — optional, later

**Deployment**
- Preferred early version: MCP server lives **inside** the Coordinator Service (same deploy unit)
- Later option: thin MCP sidecar

---

## 4. Core Data Model

### Org (lightweight)

```text
Org
  id
  name
  created_at
```

### Project

```text
Project
  id
  org_id
  name
  slug                          // optional
  custom_instructions           // markdown / system prompt
  default_response_channel_id   // FK → ProjectSource (usually Discord)
  status                        // active | archived | deleted
  created_by
  created_at
  updated_at
```

### ProjectSource

```text
ProjectSource
  id
  project_id

  type                    // discord_channel | email_address | clickup_list |
                          // google_drive_folder | github_repo | ...

  external_id             // Discord snowflake, email address, ClickUp list id,
                          // Drive folder id, repo full name, etc.

  name                    // display name
  direction               // inbound | outbound | both

  is_default_response     // boolean – at most one true per project
  config                  // JSON – type-specific settings

  status                  // active | disabled
  connected_by
  created_at
  updated_at
```

**Constraints**
- `(type, external_id)` unique — especially critical for `discord_channel` (enforces 1:1)
- At most one `is_default_response = true` per project

### MemoryEntry

```text
MemoryEntry
  id
  project_id
  ticket_id               // optional – linked when written in the context of a ticket
  type                    // email_summary | manual | status_update |
                          // worker_result | worker_note | note | ...

  title
  content
  source_metadata         // JSON (email headers, Discord message id, ticket id,
                          //       worker_id, progress %, …)

  created_by              // nullable (user | worker | system)
  created_at
```

### Ticket  (the central work item)

```text
Ticket
  id
  project_id
  coordinator_session_id  // optional link to Pi Durable conversation

  status                  // open | assigned | in_progress | blocked |
                          // completed | failed | cancelled

  title                   // short summary
  intent                  // from Jev
  input_summary           // what was asked
  priority                // optional

  worker_type             // daytona_pi | local_claude | local_pi | ...
  worker_id               // which worker instance is assigned (if known)
  worker_endpoint         // unused under pull model; kept for a possible push mode later

  result                  // JSON – structured final result (when completed)
  error

  created_by              // coordinator / system
  created_at
  assigned_at
  started_at
  last_activity_at        // bumped on every event / status change
  completed_at
  updated_at
```

### TicketEvent  (conversation + status log on the ticket)

```text
TicketEvent
  id
  ticket_id

  type                    // created | assigned | status_update | comment |
                          // follow_up | result | error | system

  actor                   // coordinator | worker | system
  actor_id                // optional

  body                    // human-readable message or status text
  payload                 // JSON – structured data (progress %, step, artifacts, …)

  created_at
```

This is the internal chat / activity stream of the ticket. Coordinator and Worker both append events here (Worker via MCP `ticket_append_event`).

### Worker  (registry + health)

```text
Worker
  id                      // worker_id, e.g. joel-local-claude
  worker_type             // daytona_pi | local_claude | local_pi | ...
  status                  // online | offline (derived from last_seen_at)
  current_ticket_id       // optional
  last_seen_at            // updated by worker_heartbeat
  created_at
```

Ticket also gets `last_activity_at` (updated on every TicketEvent and status change), so the Coordinator can check tickets by time.

### User

```text
User
  id
  email
  name
  role                    // admin | member
  org_id
  created_at
```

---

## 5. Key Runtime Flows

### 5.1 Normal Discord message → Ticket

```
Discord message in a project channel
        ↓
Discord Adapter → Coordinator (normalized message)
        ↓
Coordinator
  • Lookup ProjectSource by channel id → Project
  • Load context + memory
  • Jev classifies intent
  • Create Ticket (status = open)
  • Assign to Worker (status = assigned, worker_id / worker_type)
  • Append TicketEvent: created + assigned
        ↓
Worker session starts (MCP client)
  • ticket_list_assigned → finds the assigned, unpicked ticket
  • ticket_claim → in_progress
  • ticket_get
  • project_memory_read as needed
  • Works the ticket
  • ticket_append_event (status_update, comment, …)
  • project_memory_write (notes, findings; linked to ticket_id)
  • ticket_append_event (result) + ticket_update_status → completed
        ↓
Coordinator
  • Sees completion (via event or poll)
  • Builds customer-facing reply
  • Instructs Discord Adapter to post reply
```

### 5.2 Long-running ticket with follow-ups

```
Ticket is in_progress
        ↓
Coordinator appends TicketEvent (follow_up / “what’s the status?”)
        ↓
Worker sees it on its next ticket_get and responds with ticket_append_event (status_update + payload)
        ↓
Coordinator may:
  • Write a progress note to Project Memory
  • Post a curated progress update to the channel
  • Ask another follow-up on the ticket
        ↓
Worker eventually posts result event → Ticket completed
        ↓
Coordinator posts final reply to channel
```

### 5.3 Email message

```
Inbound email
        ↓
Email Adapter → Coordinator
        ↓
Coordinator resolves project → creates Ticket → marks it assigned → Worker pulls it
        ↓
… same ticket lifecycle …
        ↓
Coordinator posts summary to the project’s default_response_channel
```

### 5.4 Admin configuration (Discord)

```
Admin message in the dedicated Admin channel
        ↓
Coordinator authenticates admin
        ↓
Parses intent (create project, add source, set default channel,
              “status of ticket X”, …)
        ↓
Mutates Project Memory  or  reads Ticket / TicketEvents
        ↓
Confirms back in the Admin channel
```

### 5.5 Coordinator health checks (ticket time + worker health)

The Coordinator runs a sweep on a timer (e.g. every minute). Thresholds are config, defaults below.

```
Every minute, Coordinator checks:

Workers
  • last_seen_at older than 15 min (3 missed watcher polls) → mark Worker offline

Tickets in `assigned`
  • assigned Worker offline, or not picked after 30 min
      → append system event, reassign (another worker of same type) or flag to admin

Tickets in `in_progress`
  • no activity for 15 min → append follow_up ("status?")
  • no activity for 30 min, or Worker offline
      → mark failed (or back to `assigned` for a retry, max N retries)
      → post a curated note to the channel if the requester is waiting
```

- Watcher calls `worker_heartbeat` every poll (5 min), even when idle.
- An active Claude Code session calls `worker_heartbeat` with its `ticket_id` while working; any ticket event also bumps `last_activity_at`.
- Health state is visible in the admin channel ("worker status", "stuck tickets") and the Web UI.

### 5.6 POC deployment: local Docker Compose

Everything runs on one machine in one Compose network. No auth, no public endpoints.

```
docker compose
  ├─ coordinator      Coordinator Service + MCP server + Web UI API
  ├─ db               database for Project Memory, Tickets, Workers
  ├─ discord-adapter  Discord bot (outbound connection to Discord)
  ├─ email-adapter    optional / stub for POC (e.g. local SMTP catcher)

host (outside Compose)
  └─ watcher          Local Watcher + Claude Code, using the host's
                      Claude Code login; talks to the coordinator's
                      published port (e.g. http://localhost:PORT/mcp)
```

- The watcher runs on the host (decided), so Claude Code uses the host's existing login and local repos. It reaches MCP through the coordinator's published port.
- Daytona Workers are out of scope for the first local test; `local_claude` via the watcher is the first Worker type.

### 5.7 Per-person Google and GitHub access

Workers read Drive and GitHub with the token of the person who asked, never a shared bot credential, so Google's and GitHub's own permissions decide what a Worker can reach. Account linking runs on [Better Auth](https://www.better-auth.com) (`packages/auth`), behind the `UserConnections` port.

```text
/connect provider:google           (Discord, any channel or DM; ephemeral reply)
  → Coordinator: auth user for (discord, user id), one-time link, 10 min
  → browser: GET /connect/:token   → session for that user → Better Auth link-social
  → provider consent               → GET /api/auth/callback/google
  → Better Auth stores the account (tokens encrypted)  → /connect/done
```

- **Whose token.** `user_token(ticket_id, provider)` resolves the sender of the ticket's latest `created` or `follow_up` event. A follow-up from someone else switches to their own token (Joel, 2026-11-06).
- **Passed to Workers.** The tool returns the access token itself, so `gh`, `git` and the Drive API work directly (Joel, 2026-11-06). Workers must not store or print it.
- **Not linked.** The tool fails `NotConnected` and the Coordinator asks the person in the project channel to `/connect` (once a day per ticket); the Worker sets the ticket `blocked`.
- **Refresh.** Better Auth refreshes an access token that has under 5 s left before returning it. A failed refresh reads as `NotConnected` (link again).
- **Storage.** Better Auth's `auth_users` / `auth_accounts` / `auth_sessions` / `auth_verifications` tables, tokens encrypted with `BETTER_AUTH_SECRET`. An auth user is one channel identity; its email is a placeholder (`discord-<id>@people.project-os.invalid`).
- **Providers.** Google: OAuth web client, `drive.readonly`, offline access. In Testing mode, refresh tokens last 7 days, so people re-link weekly until the app is verified (accepted, Joel, 2026-11-06). GitHub: a GitHub App's user tokens (8 h, refreshable), limited to repos the app is installed on and the person can access.
- **Commands.** `/connect`, `/disconnect`, `/connections`.

---

## 6. API Surface

### For Web UI / Admin (HTTP)

- `GET/POST /projects`
- `GET/PATCH /projects/:id`
- `POST /projects/:id/sources`
- `DELETE /projects/:id/sources/:sourceId`
- `PATCH /projects/:id/sources/:sourceId`
- `GET /projects/:id/memory`
- `POST /projects/:id/memory`
- `GET /projects/:id/tickets`
- `GET /tickets/:id` (+ events)
- `GET /workers` (online/offline derived from `lastSeenAt`)
- `GET /activity?since=` (tickets changed and events appended since a time, plus workers; polled by the dashboard's live system map)
- Settings endpoints as needed

### For Workers (MCP only)

| Tool | Purpose |
|------|---------|
| `ticket_list_assigned` | Tickets assigned to this worker but not yet picked up |
| `ticket_claim` | Atomically take an assigned ticket (→ in_progress) |
| `ticket_get` | Full ticket + recent events |
| `worker_heartbeat` | Report Worker alive (+ current ticket) |
| `ticket_append_event` | Append status_update, comment, result, error, … |
| `ticket_update_status` | Update ticket status |
| `ticket_ask` | Ask for approval or a multiple choice pick (Discord buttons) |
| `ticket_get_prompt` | Read the answer to a `ticket_ask` |
| `project_memory_read` | Read project memory / context |
| `project_memory_write` | Write MemoryEntry (optionally linked to ticket) |
| `project_memory_search` | Optional, later |
| `user_token` | The latest message author's own Google / GitHub token (§5.7) |

No auth on MCP (sandbox). Ticket-scoped tokens deferred.

### Internal (used by agent loop)

- Resolve channel → project
- Load full project context
- Create / assign tickets
- Append and read TicketEvents
- Write memory entries
- Orchestrate long-running tickets

---

## 7. Open / Deferred Items

- Coordinator stack: TypeScript + Effect + Elysia + Drizzle; Cloudflare (Workers, D1, KV) as target, local Bun/SQLite for POC (§8)
- Auth for Web UI and admin Discord actions
- Per-ticket scoped Worker auth tokens (deferred; sandbox assumed, no auth concern)
- Detailed JSON schemas for TicketEvent.payload and Ticket.result
- ClickUp source connector (shape ready in ProjectSource); Drive and GitHub are reached with each person's own token (§5.7)
- Multi-org / multi-tenant hardening
- Observability and audit log
- How Workers get the MCP endpoint + `worker_id` config in Daytona vs local agents
- Exact health thresholds and retry limit
- Network setup beyond the local Compose POC (VPN / tunnel / public MCP URL)
- How a Worker notices Coordinator follow-ups while busy (re-read `ticket_get` between steps)
- Push assignment as a later option (would use `worker_endpoint`)

---

## 8. Monorepo Layout & Provider Architecture

### 8.1 Targets

| Target | Runtime | Database | KV | Timers | Use |
|--------|---------|----------|----|--------|-----|
| **Cloudflare** (production target) | Cloudflare Workers | D1 via Drizzle | Workers KV | Cron Triggers | Real deployment |
| **Local** (POC first) | Bun in Docker Compose | SQLite via Drizzle (`bun:sqlite`) | in-memory / SQLite table | `setInterval` | Local test |

D1 is SQLite, so both targets share **one Drizzle SQLite schema and one set of migrations**. Other providers (Postgres, Redis, another host) plug in by implementing the same interfaces.

### 8.2 Clean architecture: ports and adapters

```
            ┌─────────────────────────────────────────────┐
            │  domain        entities, rules, errors      │  no I/O, no provider imports
            ├─────────────────────────────────────────────┤
            │  application   use cases + PORTS            │  depends on domain only
            │                (interfaces)                 │
            └──────────────▲──────────────────────────────┘
                           │ implements
    ┌──────────────────────┼───────────────────────────┐
    │ infra-cloudflare     │ infra-local     │ infra-x │  adapters per provider
    │ D1 · KV · Cron · DO  │ bun:sqlite ·    │ (later) │
    │                      │ memory · timer  │         │
    └──────────────────────┴─────────────────┴─────────┘
                           ▲ wired by
            ┌──────────────┴──────────────────────────────┐
            │  apps/*        composition roots            │  pick a provider Layer per target
            │  main.cloudflare.ts · main.bun.ts           │
            └─────────────────────────────────────────────┘
```

Dependencies only point inward. Ports are Effect `Context.Service`s, and each provider package exports a `Layer` that implements them. Switching provider means switching the Layer in the entry file. Use cases don't change.

**Ports (in `packages/core/src/application/ports`)**

| Port | Purpose | Cloudflare | Local |
|------|---------|------------|-------|
| `TicketRepository` | tickets + events, atomic claim | D1 | bun:sqlite |
| `ProjectRepository` / `ProjectSourceRepository` | projects, channel → project | D1 | bun:sqlite |
| `MemoryRepository` | MemoryEntry read/write/search | D1 (+ FTS later) | bun:sqlite |
| `WorkerRepository` | registry + heartbeat | D1 | bun:sqlite |
| `KeyValueStore` | cache, dedupe of inbound messages, short-lived state | Workers KV | in-memory / SQLite |
| `ChannelGateway` | send reply instruction to an adapter | HTTP / service binding | HTTP |
| `Scheduler` | run the health sweep every minute | Cron Trigger | `setInterval` |
| `IntentClassifier` | Jev intent classification (§8.6) | pi-ai `classify` → OpenRouter (or Workers AI) | pi-ai `classify` → OpenRouter |
| `AgentRuntime` | Pi Durable conversation: reply composition, admin dialogue | Harness in a Durable Object (DO SQLite storage) | Harness in-process (SQLite file storage) |
| `WorkerLauncher` | start a Daytona sandbox (later) | Daytona API | no-op |
| `UserConnections` | per-person Google / GitHub links + their tokens (§5.7) | Better Auth on D1 | Better Auth on bun:sqlite (`packages/auth`) |
| `Clock` / `IdGenerator` | testable time + ids | shared default | shared default |

Repository ports are defined per aggregate rather than as a generic `Db`, so a non-SQL provider can implement them too.

### 8.3 Folder structure

```
project-os/
├─ apps/                               # composition roots + transport only
│  ├─ coordinator/
│  │  ├─ src/
│  │  │  ├─ http/                      # Elysia routes: /inbound, Web UI API (§6)
│  │  │  ├─ mcp/                       # MCP server, tools → use cases
│  │  │  ├─ app.ts                     # builds the Elysia app from a provider Layer
│  │  │  ├─ main.cloudflare.ts         # Elysia + CloudflareAdapter, .compile(); scheduled handler, DO export
│  │  │  └─ main.bun.ts                # Bun.serve + setInterval sweep
│  │  ├─ wrangler.jsonc                # D1, KV, DO, cron bindings
│  │  └─ Dockerfile                    # local target (oven/bun)
│  ├─ discord-adapter/
│  ├─ email-adapter/                   # stub for POC
│  ├─ watcher/                         # host-run Bun CLI
│  │  ├─ src/{config,poll,spawn,main}.ts
│  │  └─ prompts/session-start.md
│  └─ web/                             # Web UI (later)
│
├─ packages/
│  ├─ core/                            # domain + application, provider-free
│  │  └─ src/
│  │     ├─ domain/                    # one domain module per entity
│  │     │  ├─ project/
│  │     │  ├─ project-source/
│  │     │  ├─ memory/
│  │     │  ├─ ticket/                 # Ticket, TicketEvent, status machine
│  │     │  ├─ worker/
│  │     │  └─ user/
│  │     │     # each: entity.ts · errors.ts (Data.TaggedError) · index.ts
│  │     └─ application/
│  │        ├─ ports/                  # interfaces from §8.2
│  │        └─ use-cases/              # handle-inbound, create-ticket, claim-ticket,
│  │                                   # append-event, health-sweep, admin-command, ...
│  ├─ contracts/                       # wire types: inbound message, reply
│  │                                   # instruction, MCP tool schemas, enums
│  ├─ db-sqlite/                       # shared Drizzle SQLite schema + migrations
│  │  ├─ src/schema/                   # one file per table
│  │  ├─ src/repositories/             # Drizzle repos, take any SQLite Drizzle db
│  │  └─ migrations/
│  ├─ infra-cloudflare/                # Layer: D1 db, KV, Cron, DO AgentRuntime
│  ├─ infra-local/                     # Layer: bun:sqlite db, memory KV, timer
│  ├─ auth/                            # Better Auth: UserConnections Layer, /connect
│  └─ testing/                         # in-memory fakes of every port
│
├─ libs/
│  └─ config/                          # env parsing per target
│
├─ docker-compose.yml                  # local target
├─ package.json · bun.lock · vite.config.ts · tsconfig.base.json
├─ docs/ · CONTEXT.md
```

`infra-cloudflare` and `infra-local` both reuse `db-sqlite/repositories`. They differ only in how the Drizzle db is created (`drizzle-orm/d1` vs `drizzle-orm/bun-sqlite`). A Postgres provider would add `db-postgres` + `infra-<host>`.

### 8.4 Dependency rules

| Package | May depend on |
|---------|---------------|
| `packages/core` | `packages/contracts`, `effect` only. **No** Drizzle, Cloudflare, Bun, or Elysia imports |
| `packages/db-sqlite` | `core` (ports), `drizzle-orm` |
| `packages/infra-*` | `core`, `db-sqlite`, its provider SDK |
| `packages/auth` | `core`, `contracts`, `db-sqlite`, `better-auth` |
| `packages/testing` | `core` |
| `apps/coordinator` | everything above; picks one `infra-*` per entry file |
| `apps/*-adapter`, `apps/watcher` | `contracts`, `libs/config` only |

Enforce these with lint import rules in the Vite+ config.

### 8.5 Notes and conflicts

- **Conflicts with `CONTEXT.md`:** it says each domain module colocates its own Drizzle schema. Clean architecture moves the schema out of `core` into `db-sqlite`, so `core` stays provider-free. `CONTEXT.md` needs updating when we start coding. The `Db` service there becomes an infra detail behind the repository ports.
- **HTTP framework: Elysia.** Native on Bun. On Workers it uses the experimental `CloudflareAdapter` (`elysia/adapter/cloudflare-worker`) and needs `.compile()` and `compatibility_date >= 2025-06-01`. On Workers, the static plugin, `Elysia.file`, and OpenAPI type generation don't work (no `fs`). Use Wrangler `assets` for static files.
- **Discord adapter: long-running gateway process (Hermes model).** Hermes Agent's messaging gateway is a single background process that opens an *outbound* Discord Gateway WebSocket. It needs no public URL or inbound port, which is why it looks "webhook-free". HTTP interactions alone can't be used, because they only deliver slash commands and buttons, not ordinary channel messages. So `discord-adapter` is a standalone Bun process that holds the gateway connection and calls the coordinator over HTTP. Locally it runs in Compose. On the Cloudflare target, it either runs anywhere that allows a long-running process (a small VM, Fly, a Cloudflare Container) or lives in a Durable Object that keeps the outbound WebSocket open (that DO can't hibernate, so it's always billed). The coordinator itself stays a normal Worker either way.
- **Agent runtime:** see §8.6.
- **Atomic claim:** `ticket_claim` is a single conditional `UPDATE … WHERE status = 'assigned'`, which works the same on D1 and bun:sqlite.
- **Tooling:** Bun is the package manager (workspaces in the root `package.json`) and the local runtime (Docker images on `oven/bun`, watcher on the host). Vite+ (`vp`) handles task running and caching, build, test (Vitest), lint, and format, replacing Turborepo. `wrangler` handles Cloudflare dev and deploy.
- `libs/auth` (Better Auth) is dropped for the POC since there's no auth. It comes back as an `Auth` port when Web UI auth is designed.
- The v1.1 throwaway `Task` entity in `CONTEXT.md` is no longer needed once `ticket/` exists.

### 8.6 Pi Durable + Jev

**Pi Durable** ([`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable), experimental, API changes between releases) is the Coordinator's agent loop. It is a durable harness: conversations, model turns, tool calls, and its own tasks are committed to storage before anything is shown, so a crashed process resumes where it stopped.

- One Pi conversation per Project (the root conversation per project, or one per channel thread later). Inputs are submitted with `requestId = externalId`, so a re-delivered Discord message is not answered twice.
- Pi's job in the POC is narrow: compose the curated channel reply from a finished ticket, and run the admin-channel dialogue. It does **not** execute the work; Workers do.
- Coordinator actions are exposed to Pi as extension tools that call core use cases (`create_ticket`, `ticket_status`, `create_project`, `add_source`, …). Pi never gets channel tools; replies go out through `ChannelGateway`. `create_project` asking the Coordinator to create the project's channel is not a channel tool: the Coordinator still owns the adapter call, and Pi never posts.
- Storage: local target uses Pi's SQLite storage on a file next to the app database; Cloudflare uses `openDurableObjectSqliteStorage` inside a Durable Object, waking via `onWake` + alarms.
- Models come from `@earendil-works/pi-ai` with the OpenRouter provider (`OPENROUTER_API_KEY`). The chat model id is config.

**Jev** (TypeSafe's System One decision model) is the classifier. It returns a typed choice with probabilities and confidence, not free text. It is called through pi-ai's `models.classify()` on the OpenRouter provider (OpenRouter serves TypeSafe's System One protocol; it is not a chat-completions model).

- Pin a version (`typesafe/jev-1.14` on OpenRouter), not `~typesafe/jev-latest`.
- One request per inbound message, all questions evaluated together:
  - `intent` (choice): `new_request`, `follow_up` (on an open ticket), `status_question`, `admin_command`, `chit_chat`, `none`
  - `worker_type` (choice): `local_claude`, … (only meaningful for `new_request`)
  - `needs_worker` (bool): does this need a Worker, or can the Coordinator answer from Project Memory
- The option sets live in code; Jev only chooses between them. Below a confidence threshold (config, start at 0.5) the Coordinator asks a clarifying question instead of creating a ticket.
- Keep counting, arithmetic, and date logic in code, not in Jev questions.
- On Cloudflare, Jev is also available on Workers AI (`typesafe/jev-1.14.0`) through the same `IntentClassifier` port.

Flow: inbound → `IntentClassifier` (Jev) → use case decides (create/assign ticket, append follow_up, answer status, route to admin) → on completion `AgentRuntime` (Pi) composes the reply → `ChannelGateway`.

---

## 9. Migration Note

v1.1 was a single Durable Object agent that both planned and executed tools.  
v2.x separates concerns and adopts a **ticket-driven** internal process with MCP:

- Coordinator creates tickets and owns channel communication
- Workers work tickets through MCP tools (`ticket_*`, `project_memory_*`), share Project Memory, and communicate only via the ticket
- Project Memory is the durable project brain
- Channels are pure adapters
- Workers pull assigned tickets on session start
- Worker auth tokens are deferred (sandbox, no auth concern)

This mirrors how real teams use tickets: the coordinator creates work, assigns it, follows up on the ticket, and only surfaces curated updates to the customer/channel.
