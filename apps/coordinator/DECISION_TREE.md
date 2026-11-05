# Inbound decision tree

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
