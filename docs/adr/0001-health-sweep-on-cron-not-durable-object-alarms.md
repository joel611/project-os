# Health sweep runs from a Cron Trigger, not Durable Object alarms

Status: accepted (2026-11-11)

## Context

After a ticket is handed to a Worker, the Coordinator must notice silence: assign queued tickets, ask a quiet Worker for status, flag a stalled assignment, and fail a dead ticket (`healthSweep`, technical-architecture.md §5.5). On Bun a `Scheduler` timer runs it. A Cloudflare Worker has no process to hold a timer, so it needed a different trigger.

Two options:

1. **Cron Trigger** calling a `scheduled` handler that runs `healthSweep` over D1 every minute.
2. **Durable Object alarms**: on assignment, store a `watch:<ticketId>` record in a Durable Object and arm one `setAlarm()` per object, rescheduled to the earliest due watch; the handler checks each due ticket.

## Decision

Use the Cron Trigger (`crons: ["* * * * *"]` in `alchemy.run.ts`, `scheduled` in `apps/coordinator/src/main.cloudflare.ts`). Event-driven reporting stays the primary path: `ticket_update_status` goes through `updateStatusAndNotify`, which posts completed, failed and blocked to the ticket thread at once. The sweep is the safety net for silence.

## Why not alarms for ticket monitoring

- **Tickets are not in a Durable Object.** They live in D1. `PiAgent` objects are per Pi session (`project:<id>`, `admin:<channel>`, `sidekick:<ticket>`). An alarm watching all tickets would need a new singleton object, or one watch per project object. One Cron scan already sees every ticket.
- **Queued tickets have no owner.** A ticket with no free Worker is `open` with no object watching it. The sweep assigns it when room appears; a per-ticket alarm cannot.
- **One source of truth.** A `watch:<id>` record duplicates `lastActivityAt` and the event log in D1. Each Worker event would have to update both, and a missed update leaves them disagreeing.
- **The logic already exists and is tested.** `healthSweep` has tunable thresholds (`unpickedMs`, `followUpMs`, `inactivityFailMs`), appends the `follow_up` event, and is idempotent. Only the trigger was missing.
- **Cost.** One D1 scan per minute, however many tickets exist. Alarms add per-object wake-ups and `getAlarm()` bookkeeping.

## Consequences

- Detection latency is up to one minute. Cron cannot go lower.
- Thresholds are minutes-scale, so a minute of granularity is acceptable.
- If sub-minute checks are ever needed, add a singleton `TicketWatcher` Durable Object that runs the same `healthSweep` from an alarm. The sweep logic does not change, so this stays a cheap switch.

## Where alarms still belong

Pi Durable asks Durable Object hosts to pass `onWake` and arm `setAlarm()`, so an evicted `PiAgent` resumes an unfinished reply turn. That state is per object, which alarms suit. `PiAgent` does not do this yet; it is a separate change (apps/site/guide/deployment.md, Known gaps).
