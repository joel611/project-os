---
"@project-os/contracts": minor
"@project-os/coordinator": minor
"@project-os/channel-discord": minor
"@project-os/web": minor
---

Add the Channel Digest: the Coordinator now keeps every message in a linked Discord project channel and its ticket threads, @mention or not, and once a conversation has been quiet for 30 minutes (or 6 hours after its first message) saves the decisions and lasting facts in it to Project Memory as `decision` and `note` entries. Each entry's `sourceMetadata` keeps the messages it came from, most relevant first: sender, time, a quote and a Discord link, shown under the entry on the dashboard. It runs on the health sweep's per-minute tick (Cron on Cloudflare), makes one model call per conversation (`CHANNEL_DIGEST_MODEL`, else `DEFAULT_MODEL`), and deletes the raw messages once digested or after 7 days. Per project in Settings → General: on/off (default on) and whether to post what it saved in the channel (default off). Adds the `channel_messages` table and two `projects` columns (migration `channel_digest`).
