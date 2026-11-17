---
"@project-os/core": minor
"@project-os/db-sqlite": minor
"@project-os/system-prompts": minor
"@project-os/web": minor
"@project-os/agent-runtime": minor
"@project-os/contracts": minor
"@project-os/channel-discord": minor
"@project-os/coordinator": minor
---

A follow-up in a finished ticket's Discord thread now reopens the ticket instead of being turned away. A `completed` or `failed` ticket goes back to `open` with its worker and last run cleared, gets a `reopened` audit entry and a `system` event, and is placed again like a new ticket; the thread is told it was reopened (or queued). The next Worker reads the earlier result and the new ask on the same ticket. Status questions are still answered directly, and a `cancelled` ticket stays closed. A ticket that completes again gets its own completion reply.

Messages in a ticket's thread are now classified with that ticket as context (title, ask, status and an excerpt of its last result), and the classifier says whether the message is about that ticket. Small talk on a finished ticket no longer reopens it. A clearly unrelated new request gets "New ticket / Part of this ticket" buttons: "New ticket" opens it in a new Discord thread and links it from the old one, "Part of this ticket" adds it as a follow-up. The Discord adapter can open a thread with no starter message (`/threads` without `messageId`).
