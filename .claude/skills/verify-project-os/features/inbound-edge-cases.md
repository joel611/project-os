# Inbound edge cases

## Sub-features

- Same Discord message id delivered twice → one ticket
- Message from a channel not linked to any project → no ticket, no reply

## How to get to it (user POV)

Discord retries a delivery, or a user speaks in an unrelated channel.

## Driving it with the harness

- Unlinked: `bun verify/drive.ts say "hello?" --channel other-chan` → `GET /projects/<id>/tickets` unchanged, `posted.jsonl` unchanged.
- Duplicate: `drive.ts` generates a fresh message id every time, so it cannot send one. POST the same JSON body twice to `/inbound` with curl (body shape: output of `fakeInbound` in `packages/channel-discord/src/fake.ts`); expect one ticket.

Proves it: ticket count and reply count unchanged.

## Gotchas

- The duplicate path is not covered by this skill's helpers; `apps/e2e/src/discord-loop.test.ts` ("ignores a duplicate delivery") covers it.
- Low-confidence classifier and admin-channel paths are unreachable here (classifier is fixed in `serve.ts`).
