# Coordinator

The single service that owns intent classification, Project Memory, the Ticket lifecycle, the MCP server, and every outbound message to channels. Channel Adapters and Workers never talk to each other; they only talk to the Coordinator.

## What happens when a message arrives

Entry point: `POST /inbound` (`src/http/routes.ts`) → `handleInbound` (`packages/core/src/application/use-cases/handle-inbound.ts`).

```
   INBOUND GATEWAY                      COORDINATOR                          WORKER
                                   (handleInbound decision tree)
 ┌────────────────┐
 │ Discord / email│
 │ channel adapter│
 └───────┬────────┘
         │ POST /inbound
         │ (InboundMessage)
         ▼
                                  ┌─────────────────────────┐
                                  │ dedupe: inbound:{ch}:{id}│
                                  │ already seen?           │──yes──▶ duplicate (drop)
                                  └────────────┬────────────┘
                                               │ no
                                               ▼
                                  ┌─────────────────────────┐
                                  │ admin channel?          │
                                  └───────┬─────────┬───────┘
                                      yes │         │ no
                    ┌─────────────────────┘         │
                    ▼                               ▼
          sender in adminUserIds?          ┌─────────────────────────┐
            no ─▶ reply "Not authorized"   │ find Project by         │
                  (admin_forbidden)        │ (sourceType, channelId) │
            yes ▼                          └───────┬─────────┬───────┘
          classify (no project ctx)           none │         │ found
          confident AND admin_command?             ▼         ▼
            no ─▶ clarify               unlinked (drop)  classify(project.customInstructions)
            yes ▼                                          │
          AgentRuntime.respond                             ▼
          reply with text ◀──────────────┐        confidence >= 0.5 ?
          (admin_handled)                │          no ─▶ clarify
                                         │          yes ▼
                                         │   load active tickets of Project
                                         │   (newest activity first)
                                         │              │
                                         │   ┌──────────┼────────────┬───────────────┐
                                         │   ▼          ▼            ▼               ▼
                                         │ new_request follow_up status_question  other intent
                                         │   │          │            │            (chit_chat, none,
                                         │   │          │            │             admin_command)
                                         │   │      active ticket?   │                 │
                                         │   │       no ─▶ clarify   │                 ▼
                                         │   │       yes ▼           │              clarify
                                         │   │   append follow_up    │
                                         │   │   event to newest     │
                                         │   │   active ticket       │
                                         │   ▼          │            ▼
                                         │ insert Ticket(open)   AgentRuntime.respond
                                         │ + "created" event     (question + active tickets)
                                         │ assign(workerType,        │
                                         │   workerId)               │
                                         │ + "assigned" event        │
                                         │   │                       │
 ┌────────────────┐                      │   │ ticket status         │
 │ POST /reply    │◀── ChannelGateway ───┴───┼── = assigned ─────────┘
 │ (adapter posts │    send(reply)           │
 │  to channel)   │                          ▼
 └────────────────┘                  ┌───────────────┐
                                     │ ticket store  │◀──────────────┐
                                     └───────┬───────┘               │
                                             │                       │
                                             │  MCP server           │
                                             │                ┌──────┴────────────────┐
                                             └───────────────▶│ Watcher polls every   │
                                                              │ 5 min for assigned,   │
                                                              │ unclaimed Tickets and │
                                                              │ starts a Worker       │
                                                              └──────┬────────────────┘
                                                                     ▼
                                                              ticket_list_assigned
                                                              ticket_claim
                                                                (assigned → in_progress)
                                                              project_memory_read/write
                                                              ticket_append_event
                                                              ticket_update_status
                                                                (completed / failed / blocked)
                                                                     │
                                  on-ticket-completed ◀──────────────┘
                                  on completed: compose reply, send to
                                  project's default-response source
                                  via ChannelGateway ─▶ adapter ─▶ channel
```

Left: where messages enter and where replies leave. Centre: every decision the Coordinator makes. Right: Workers pull assigned Tickets over MCP and push results back; they never reach a channel.

## Decisions

| Step | Check                                                           | Outcome                                                                                  |
| ---- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Dedupe key already stored (TTL 24h by default)                  | `duplicate`, no work                                                                     |
| 2    | Admin channel and sender not in `adminUserIds`                  | `admin_forbidden`                                                                        |
| 3    | Admin channel: confident `admin_command`                        | `AgentRuntime.respond` on session `admin:{channelId}`, `admin_handled`                   |
| 4    | No ProjectSource for `(sourceType, channelId)`                  | `unlinked`, dropped silently                                                             |
| 5    | Classifier confidence below `confidenceThreshold` (default 0.5) | `clarification_sent`                                                                     |
| 6    | Intent `new_request`                                            | Ticket `open` → `assigned`, `ticket_created`                                             |
| 6    | Intent `follow_up`                                              | `follow_up` event on newest active Ticket, `follow_up_added`; no active Ticket → clarify |
| 6    | Intent `status_question`                                        | `AgentRuntime.respond` on session `project:{id}`, `status_answered`                      |
| 6    | Any other intent                                                | `clarification_sent`                                                                     |

Worker type for a new Ticket: classifier `worker_type` answer, else `defaultWorkerType`, else `local_claude`.

## Intent classifier

`packages/agent-runtime/src/intent-classifier.ts`. One Jev call per message with three questions:

- `intent`: `new_request`, `follow_up`, `status_question`, `admin_command`, `chit_chat`, `none`. Its confidence feeds the threshold.
- `worker_type`: `local_claude`, `local_pi`, `daytona_pi`. Used only for `new_request`.
- `needs_worker`: bool. Computed but not yet read by `handleInbound`.

## Known limits

- `follow_up` attaches to the newest active Ticket of the Project, not matched by content or thread.
- Follow-ups get no acknowledgement reply.
- `chit_chat` gets the clarification text, not a greeting.
- The Coordinator never starts Workers; it only assigns Tickets. Pickup latency is the Watcher poll interval.
