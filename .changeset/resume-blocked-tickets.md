---
"@project-os/core": patch
"@project-os/db-sqlite": patch
"@project-os/system-prompts": patch
---

A blocked ticket now starts again when the person answers. Before, a Worker set the ticket to `blocked` and ended its session, and nothing ever placed it again, so "try again" after `/connect` did nothing. Now any message in a blocked ticket's thread, or a button answer to its `ticket_ask` prompt, reopens it (`blocked → open`, placed again) and the thread is told "Picking this back up." The next Worker reads the follow-ups after the block. The "please `/connect`" ask is posted in the ticket's thread (else the project channel) and asks the person to reply there.
