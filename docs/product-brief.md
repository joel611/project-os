# Project Agent – Product Brief (v1.0)

**Status:** Phase 1 scope locked  
**Last updated:** 2026-09-23

---

## One-sentence pitch

A Project-centric AI agent that lets any PM or Team Lead get grounded answers across email, Drive, and (later) code — without pinging engineers or hunting through siloed tools.

## Core Win Condition

Any PM / Team Lead can ask a technical feasibility or status question and receive a cited answer without interrupting engineers.

---

## Hierarchy & Core Concepts

```
Org (domain-restricted)
 └── Folder (optional grouping – formerly “Client”)
      └── Project
```

### A Project contains

- Custom instructions (free-text markdown editor)
- Attachments (names always visible to everyone in the org):
  - Google Drive folders (any level the user selects)
  - GitHub repos / specific branches (Phase 1.5)
  - Figma links
  - IM channels
- Email memory (structured, PII-redacted summaries + metadata)
- Manual memory entries (written via Discord/Teams bot)
- Chat history
- Optional permission flag: “Agent can create PRs / write code”

### Access Model

- Projects are visible to the entire organization.
- Anyone can attach or remove sources, or delete a Project (full audit log).
- The agent **always** runs with the credentials of the person currently chatting.
- If a required source is attached but the current user has not connected that service → agent asks the user to connect or answers only with available sources.
- When a user disconnects a service, the attachment becomes a “ghost” (name remains visible; agent can prompt to reconnect or skip).

### Email Handling

- External domain addresses are treated as client-related.
- Each user sees only their own mailbox and personal “Need Assign” queue.
- Multi-recipient emails: if any recipient assigns the email to a Project, other recipients’ copies are automatically assigned to the same Project.
- Future replies in a thread auto-map when possible.
- Emails that appear to belong to multiple Projects require explicit user approval.
- Only original recipients can open the real Gmail link.
- Everyone else sees the structured, PII-redacted summary stored in the Project.

### Instant Messaging

- User-connected accounts only.
- On Project creation the system can optionally create a channel (no users are auto-added; people join manually).
- A bot is assigned to the channel and listens to all messages.
- Users can `@mention` the bot to trigger the full Project agent flow (same as the primary chat interface).

### Memory

- Incoming/outgoing client emails → automatic structured summary (PII redacted) stored in the Project.
- Manual: a PM can `@mention` the bot and write a memory entry (e.g. after a client phone call).

---

## Phase 1 Scope (Pilot)

**Must ship**

1. Domain-restricted login (email/password or Google OAuth)
2. Gmail connection + classification + “Need Assign” queue + structured PII-redacted summaries
3. Google Drive attachments + on-demand file reading at query time
4. Project chat interface with citations and direct source links
5. Custom instructions per Project
6. Basic audit log (who attached, removed, deleted, assigned emails, etc.)

**Explicitly deferred**

- GitHub integration (Phase 1.5)
- Agent writing code or creating PRs
- Drafting external email replies
- Fine-grained permissions (org / Folder / Project level)
- Auto-adding users to newly created channels

---

## Design Principles

1. **Credential accountability** – The agent never uses anyone else’s tokens.
2. **Visible but permissioned** – Attachment names are always visible; actual content requires the current user’s personal access.
3. **Memory persists** – Summaries and manual entries remain even after people leave the company.
4. **On-demand first** – Drive (and later GitHub) content is fetched at runtime rather than heavily pre-indexed.
5. **Project as the unit of context** – Chat, memory, attachments, and instructions all live inside a Project.

---

## Success Metrics (Pilot)

- PMs can answer the majority of “Can we do X?” / status questions without pinging engineers.
- Email classification + assignment reduces context loss when people are offline.
- Users trust the citations enough to act on the answers.
