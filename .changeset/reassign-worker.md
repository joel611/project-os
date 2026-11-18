---
"@project-os/coordinator": minor
"@project-os/web": minor
"@project-os/core": minor
"@project-os/db-sqlite": minor
"@project-os/testing": minor
---

Operators can assign or reassign a ticket's worker from its page in the dashboard, e.g. to move a ticket off a worker that is stuck. Any ticket not yet finished (`open`, `assigned`, `in_progress`, `blocked`) can be handed to a registered device, shared or personal; it goes back to `assigned` and that device's Watcher starts it on its next poll, while the old worker loses access to it. New operator-only route `POST /tickets/:id/assign` with `{ workerId }`; the ticket's activity and the audit log record who moved it.
