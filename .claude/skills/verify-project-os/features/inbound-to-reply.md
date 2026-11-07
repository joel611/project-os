# Inbound to reply

## Sub-features

- Message in a linked channel becomes an `assigned` Ticket (intent `new_request`, the shared worker `verify-box`)
- Worker claims, appends a `result` event, completes
- Completion posts a reply to the originating channel

## How to get to it (user POV)

A person types in the project's Discord channel; later the team sees an answer in the same channel.

## Driving it with the harness

1. `bun verify/drive.ts heartbeat` (the shared worker must be online, or the ticket queues), then `bun verify/drive.ts say "please add dark mode"`
2. `curl -s localhost:18080/projects/<id>/tickets` → one ticket `status:"assigned"`, `title:"please add dark mode"`. `posted.jsonl` absent/empty.
3. `bun verify/drive.ts work "added dark mode toggle"` → prints `completed ticket <id>`.
4. `curl -s localhost:18080/tickets/<id>` → `ticket.status:"completed"`, events created/assigned/…/result.
5. `cat $VERIFY_DIR/data/posted.jsonl` → one line, `target:{channelId:"verify-chan"}`, content contains the title and `added dark mode toggle`.

Proves it: ticket completed, exactly one reply recorded for `verify-chan` containing the worker's result.

## Gotchas

- Reply text comes from the echo agent runtime ("Compose a concise reply…"), not an LLM; assert on containment, not wording.
- `work` takes the oldest assigned ticket for the shared worker in `$DATA_DIR/worker.json`.
- Without a heartbeat first, the ticket stays `open` and `posted.jsonl` gets the "queued" note; this stack runs no health sweep, so it stays queued.
