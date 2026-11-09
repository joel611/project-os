# Coordinator

The single service that owns intent classification, Project Memory, the Ticket lifecycle, the MCP server, and every outbound message to channels. Channel Adapters and Workers never talk to each other; they only talk to the Coordinator.

## What happens when a message arrives

Entry point: `POST /inbound` (`src/http/routes.ts`) → `handleInbound` (`packages/core/src/application/use-cases/handle-inbound.ts`).

See [DECISION_TREE.md](./DECISION_TREE.md) for the classifier and LLM decision tree, and the tools each can use.

## Decisions

| Step | Check                                                           | Outcome                                                                                  |
| ---- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Dedupe key already stored (TTL 24h by default)                  | `duplicate`, no work                                                                     |
| 2    | Admin channel and sender not in `adminUserIds`                  | `admin_forbidden`                                                                        |
| 3    | Admin channel: confident `admin_command`                        | `AgentRuntime.respond` on session `admin:{channelId}`, `admin_handled`                   |
| 4    | No ProjectSource for `(sourceType, channelId)`                  | `unlinked`, dropped silently                                                             |
| 5    | Classifier confidence below `confidenceThreshold` (default 0.5) | `clarification_sent`                                                                     |
| 6    | Intent `new_request`                                            | Ticket `open` → `assigned` (or left `open`, queued), `ticket_created`                    |
| 6    | Intent `follow_up`                                              | `follow_up` event on newest active Ticket, `follow_up_added`; no active Ticket → clarify |
| 6    | Intent `status_question`                                        | `AgentRuntime.respond` on session `project:{id}`, `status_answered`                      |
| 6    | Any other intent                                                | `clarification_sent`                                                                     |

Who takes a new Ticket: the requester's online personal worker, else an online shared worker (registered by an admin) under `sharedWorkerMaxTickets`, else the first Sandbox Pool provider with room. With none free the Ticket stays `open`, the thread is told it's queued, and the health sweep assigns it later.

## Intent classifier

`packages/agent-runtime/src/intent-classifier.ts`. One Jev call per message with two questions:

- `intent`: `new_request`, `follow_up`, `status_question`, `remember`, `admin_command`, `chit_chat`, `none`. Its confidence feeds the threshold.
- `executor`: `worker` or `sidekick` (read-only tool lookups). Used only for `new_request`.

## Known limits

- `follow_up` attaches to the newest active Ticket of the Project, not matched by content or thread.
- Follow-ups get no acknowledgement reply.
- `chit_chat` gets the clarification text, not a greeting.
- The Coordinator starts sandbox Workers itself; registered devices pull their Tickets, so their pickup latency is the Watcher poll interval.
