# Dashboard tickets

## Sub-features

- Project page `/projects/<id>`: Tickets tab (count in tab name), rows grouped by state ("Active · N"), columns Status / Ticket / Worker / Activity
- Ticket sheet (dialog titled with the ticket title): Intent/Worker/timestamps, Result, Activity timeline
- Auto refresh every few seconds
- Assign / Reassign (Operator only, ticket not finished): button next to Worker in the Details rail opens a dialog to pick a registered device (`<name> · online|offline`); `POST /tickets/:id/assign`

## How to get to it (user POV)

Open the dashboard, pick the project in the sidebar, click a ticket title.

## Driving it with agent-browser

Needs a ticket (`inbound-to-reply.md` step 1 at least).

1. `agent-browser open http://localhost:15173/projects/<id>` · `wait 2000` · `snapshot -i`
2. Expect tab `Tickets 1`, row `Assigned…please add dark mode…verify-box…` (the worker by name; a queued ticket shows `queued`).
3. After `work`: `wait 6000` · `snapshot -i` → row starts `Completed`.
4. `click @<title link ref>` · `snapshot` → dialog "please add dark mode" contains `Completed`, heading `Activity`, `Result` / `added dark mode toggle`. Screenshot. `press Escape`.

Proves it: row status and sheet content match the API (`/tickets/<id>`).

### Reassign

1. `say` a ticket; with verify-box offline it stays Queued. Open the ticket page `/projects/<id>/tickets/<ticketId>` · `snapshot -i` → button `Assign` next to Worker.
2. `click @<Assign>` → dialog "Assign ticket", combobox `Worker`. Click it → options `verify-box · offline`, `bob-laptop · offline`. Pick `bob-laptop`, click `Assign`.
3. Activity gains `Assigned to bob-laptop by Admin`; the button now reads `Reassign`. Reassign to verify-box: `Reassigned from bob-laptop to verify-box by Admin`.
4. `drive.ts work "…"` completes it as verify-box. Proves the new worker picks it up; `GET /audit?kind=ticket` shows two `assigned` rows by person `Admin`.

## Gotchas

- `find role row --name …` never matches (row names are empty); use refs from `snapshot -i`.
- Deep link `/projects/<id>/tickets/<ticketId>` (route `projects.$projectId.tickets.$ticketId.tsx`) is not yet exercised.
- With the Coordinator unreachable the UI shows "Can't reach the Coordinator. Is it running?" (not exercised; only ever stop the instance you started).
