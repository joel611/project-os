---
"@project-os/core": patch
"@project-os/contracts": patch
"@project-os/system-prompts": patch
"@project-os/coordinator": patch
---

When a Worker blocks a ticket, the thread now hears why. `ticket_update_status` takes a `reason` for `blocked` (what the Worker needs from the people on the ticket, kept as a `status_update` event). The Coordinator shortens it to one or two sentences with an LLM turn and posts it in the ticket's thread; if that turn fails, the Worker's exact words are posted (cut at 1500 characters). With no reason it falls back to the Worker's latest comment or status update, then to the old generic line. The Worker prompt asks for a `reason` whenever it blocks.

Every blocked message also says whose account the Worker acted with (`Acting as <@id> (Name).`, the author of the ticket's latest message, the same person `user_token` uses), and so does the "please `/connect`" ask, so a blocked access can be traced to a user.
