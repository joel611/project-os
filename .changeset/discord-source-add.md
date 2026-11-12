---
"@project-os/contracts": minor
"@project-os/coordinator": minor
"@project-os/channel-discord": minor
"@project-os/web": patch
---

Add the `/source-add` Discord command: in a project channel, `link:` a GitHub repo or Google Drive folder (with an optional `alias:` and `description:`) to link it to that project. It detects the link the same way the dashboard does, now shared as `detectSource` and `suggestAlias` in `@project-os/contracts`.
