---
"@project-os/core": minor
"@project-os/db-sqlite": minor
"@project-os/system-prompts": minor
"@project-os/web": minor
---

A follow-up in a finished ticket's Discord thread now reopens the ticket instead of being turned away. A `completed` or `failed` ticket goes back to `open` with its worker and last run cleared, gets a `reopened` audit entry and a `system` event, and is placed again like a new ticket; the thread is told it was reopened (or queued). The next Worker reads the earlier result and the new ask on the same ticket. Status questions are still answered directly, and a `cancelled` ticket stays closed. A ticket that completes again gets its own completion reply.
