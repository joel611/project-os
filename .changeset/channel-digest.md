---
"@project-os/contracts": minor
"@project-os/coordinator": minor
---

Add the Channel Digest: the Coordinator now keeps every message in a linked Discord project channel and its ticket threads, @mention or not, and once a conversation has been quiet for 30 minutes (or 6 hours after its first message) saves the decisions and lasting facts in it to Project Memory as `decision` and `note` entries. It runs on the health sweep's per-minute tick (Cron on Cloudflare), makes one model call per conversation (`CHANNEL_DIGEST_MODEL_ID`, else `CHAT_MODEL_ID`), and deletes the messages once digested or after 7 days. It saves silently; `CHANNEL_DIGEST_NOTIFY=true` posts what it saved in the channel, and `CHANNEL_DIGEST=false` turns it off. Adds the `channel_messages` table (migration `add_channel_messages`).
