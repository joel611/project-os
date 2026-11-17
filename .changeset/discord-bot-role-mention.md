---
"@project-os/channel-discord": patch
---

Count an @mention of the bot's managed role (`<@&roleId>`, what Discord sends when you pick the bot's role from the @ menu) as mentioning the bot, so project channel messages that tag it that way are no longer dropped by the mention gate. The role mention is stripped from the content like a user mention.
