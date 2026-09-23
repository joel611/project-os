# Project Agent – High-Level Technical Architecture & Data Model (v1.1)

**Status:** Aligned with Product Brief v1.0 + Cloudflare stack decision  
**Last updated:** 2026-09-23

---

## 1. Tech Stack (Locked)

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend | TanStack Start (React) | Official Cloudflare Workers support |
| API / Auth routes | Cloudflare Worker | Hono or TanStack server functions |
| Database | D1 (SQLite) + Drizzle ORM | Primary store for all structured data |
| Cache / Sessions | KV | Sessions, rate limits, short-lived state |
| Auth & Organizations | Better Auth + organization plugin | Domain-restricted orgs; per-request instance |
| Agent runtime | Durable Objects (Cloudflare Agents) | Multi-step tool calling, hibernation, streaming |
| Data connectors | Custom OAuth + encrypted tokens in D1 | Separate from login auth (Gmail, Drive, later GitHub) |
| Object storage | R2 (later) | Only if large artifacts needed |
| Background jobs | Cloudflare Queues (later) | Email processing, async work |

### Why Durable Objects for the Agent

- Multi-step tool calls (Drive fetch → memory search → LLM → more tools) need longer wall time and persistent state.
- Durable Objects hibernate when idle (zero cost) and wake on demand.
- Cloudflare Agents framework provides built-in patterns for tool calling, streaming, and WebSockets.
- One agent instance can be scoped per Project chat session (or per user+project).

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Frontend – TanStack Start                       │
│  - Project list / Folder navigation                          │
│  - Project chat (scoped context)                             │
│  - Attachment management                                     │
│  - Need Assign queue (personal)                              │
│  - Settings / Connections / Custom instructions              │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS / WebSocket
┌────────────────────────────▼────────────────────────────────┐
│               Cloudflare Worker (API + Auth)                 │
│  - Better Auth (login + org, domain restriction)             │
│  - Project / Folder / Attachment CRUD                        │
│  - Chat session management                                   │
│  - Audit logging                                             │
│  - Webhook receivers (Gmail)                                 │
│  - Connector OAuth callback handlers                         │
└────────────┬───────────────────────────────┬────────────────┘
             │                               │
┌────────────▼──────────────┐   ┌────────────▼────────────────┐
│  Agent Runtime            │   │  Connector Layer             │
│  (Durable Object /        │   │  - User OAuth token store    │
│   Cloudflare Agents)      │   │  - Gmail (read + webhook)    │
│  - LLM orchestration      │   │  - Google Drive (on-demand)  │
│  - Tool calling           │   │  - GitHub (Phase 1.5)        │
│  - Citation assembly      │   │  - IM (Teams / Discord)      │
│  - Memory retrieval       │   │                              │
│  - Clarification logic    │   │                              │
└────────────┬──────────────┘   └────────────┬────────────────┘
             │                               │
┌────────────▼───────────────────────────────▼────────────────┐
│                     Data Layer                               │
│  - D1 (SQLite) via Drizzle                                   │
│  - KV (sessions, cache)                                      │
│  - R2 (optional, later)                                      │
│  - Light FTS / optional embeddings for MemoryEntries         │
└─────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

| Area | Decision | Rationale |
| --- | --- | --- |
| Drive & GitHub content | On-demand fetch at query time | Avoids heavy indexing, stays fresh, respects user permissions |
| Email | Webhook (or polling fallback) → classify → structured summary stored | Real-time enough, creates persistent memory |
| Credentials | Strictly per-user OAuth tokens (encrypted in D1) | Accountability + security |
| Agent context | Always scoped to one Project; runs inside Durable Object | Keeps answers grounded; supports long tool chains |
| Vector / search | SQLite FTS for MemoryEntries; optional light embeddings later | Most content is fetched live |
| Multi-tenancy | Strong isolation by Org (domain) via Better Auth organization plugin | Simple and secure for Phase 1 |
| Auth instance | Created **per request** (inject D1 binding) | Required pattern for Better Auth + D1 on Workers |

---

## 3. Core Data Model (D1 / SQLite)

> Note: `jsonb` from the earlier draft becomes `TEXT` storing JSON (or Drizzle `json` mode). SQLite FTS can be added on `MemoryEntry.content`.

### Organization (Better Auth organization plugin + custom fields)

- id
- name
- slug
- domain (unique, e.g. `abc.com`) – enforced on signup
- created_at

### User (Better Auth core + org membership)

- id
- email
- name
- email_verified
- image
- created_at
- updated_at
- (membership via Better Auth `member` table with roles)

### Folder (optional grouping)

- id
- org_id
- name
- created_by
- created_at

### Project

- id
- org_id
- folder_id (nullable)
- name
- custom_instructions (TEXT – markdown)
- can_write_code (INTEGER, default 0) -- Phase 1.5+
- status (active | archived | deleted)
- created_by
- created_at
- updated_at

### ProjectAttachment

- id
- project_id
- type (drive_folder | github_repo | figma | im_channel | ...)
- name (display name, always visible)
- external_id / external_url
- connected_by_user_id
- status (active | ghost)
- metadata (TEXT – JSON: branch name, etc.)
- created_at
- updated_at

### UserConnection (data connectors – separate from Better Auth login accounts)

- id
- user_id
- service (gmail | google_drive | github | teams | discord | ...)
- access_token (encrypted)
- refresh_token (encrypted)
- expires_at
- scopes
- status (active | revoked | expired)
- created_at
- updated_at

### MemoryEntry (email summaries + manual notes)

- id
- project_id
- type (email_summary | manual)
- title
- content (structured text, PII redacted)
- source_metadata (TEXT – JSON)
  - for email: message_id, thread_id, from, to, cc, date, gmail_link, original_recipients
  - for manual: created_by, source (discord/teams), etc.
- created_at
- created_by (nullable for automated email)

### ChatSession

- id
- project_id
- user_id
- durable_object_id (optional – link to agent DO)
- created_at
- updated_at

### ChatMessage

- id
- session_id
- role (user | assistant | system | tool)
- content
- citations (TEXT – JSON list of sources used)
- created_at

### AuditLog

- id
- org_id
- actor_user_id
- action (project.created | attachment.added | attachment.removed | project.deleted | email.assigned | memory.added | ...)
- target_type
- target_id
- metadata (TEXT – JSON)
- created_at

---

## 4. Key Flows

### 4.1 Email Ingestion

1. Gmail webhook (or periodic poll) notifies the Worker.
2. Worker fetches the message using the **recipient’s** stored credentials (UserConnection).
3. Classifier decides: client-related? → which Project(s)?
4. If confident → create MemoryEntry (structured summary, PII redacted) and link to Project.
5. If uncertain → put in the user’s personal “Need Assign” queue.
6. Multi-recipient handling: first assignment propagates to other recipients’ copies.

### 4.2 Project Chat (Agent Flow)

1. User opens a Project and starts/continues a chat.
2. Request is routed to (or wakes) a Durable Object scoped to that chat session / Project.
3. Agent receives: Project custom instructions + list of attachments + relevant MemoryEntries.
4. User may `@mention` specific attachments.
5. Agent decides which tools to call:
   - Search MemoryEntries (FTS or LLM filter)
   - Fetch Drive file/folder listing or content (using **current user’s** token)
   - (Phase 1.5) GitHub code search / file content
6. If a required attachment is a ghost or user lacks connection → agent asks to connect or skips.
7. Final answer always includes citations with links where possible.
8. Streaming response back to the TanStack Start frontend.

### 4.3 Manual Memory via Bot

1. User `@mentions` the bot inside a Project-linked channel.
2. Bot presents a simple “Save to Project memory” action.
3. Entry is stored as type = `manual` with the user as creator.

### 4.4 Attachment Lifecycle

- Adding an attachment only stores a reference + display name.
- Actual content is never copied into the platform.
- When the connecting user revokes their connection → status becomes `ghost`.
- Agent can still see the name and prompt the current user.

### 4.5 Auth & Domain Restriction

- Better Auth handles email/password + Google login.
- Organization plugin manages Orgs and membership.
- On signup / Google callback: enforce that the email domain matches the Org’s allowed domain (or create Org from hosted domain `hd` claim).
- Auth instance is created **per request** so the correct D1 binding is injected.

---

## 5. Security & Compliance Notes

- All third-party data-connector tokens are encrypted at rest and scoped to the individual user.
- The agent never escalates privileges or uses another user’s credentials.
- Email bodies are not stored long-term; only redacted structured summaries + metadata + original Gmail deep link.
- Full audit trail of every structural change.
- Domain restriction on signup/login prevents accidental cross-org access.
- Better Auth sessions can be backed by KV for fast edge reads.

---

## 6. Phase 1 Implementation Priorities

1. TanStack Start + Cloudflare Worker scaffolding + D1 + KV bindings
2. Better Auth (email/password + Google) + organization plugin + domain restriction
3. Project + Folder + Attachment CRUD
4. UserConnection model + Gmail OAuth (data connector) + webhook/polling + classifier + Need Assign + MemoryEntry
5. Google Drive OAuth (data connector) + on-demand read tools
6. Durable Object agent runtime with Project-scoped chat + citations + streaming
7. Basic audit log
8. Frontend screens for the above

GitHub, write actions, advanced permissions, richer IM features, and Queues come in Phase 1.5+.

---

## 7. Open Technical Questions (non-blocking)

- Exact Gmail webhook vs polling strategy and rate-limit handling on Workers
- How aggressively to chunk/summarize very large Drive files at query time inside the Durable Object
- Whether to enable SQLite FTS on MemoryEntry in Phase 1 or keep pure LLM filtering
- Preferred LLM provider (Workers AI, OpenAI, Anthropic, etc.) and tool-calling framework inside the agent DO
- Exact scoping of Durable Objects (one per chat session vs one per Project vs one per user+project)
