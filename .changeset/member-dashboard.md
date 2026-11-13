---
"@project-os/auth": minor
"@project-os/coordinator": minor
"@project-os/web": minor
"@project-os/core": minor
"@project-os/contracts": minor
"@project-os/channel-discord": minor
"@project-os/db-sqlite": minor
---

Discord members can sign in to the dashboard and see the tickets they're involved in. `/dashboard` hands out the Google link (the same as `/connect provider:Google`). Google sign-in then finds the Discord user who linked that Google account and signs in as them, as a member who sees only **My tickets**: tickets they asked for or wrote in. New `GET /me` and `GET /me/tickets` routes. `GET /tickets/:id` and its attachments are narrowed to the member's own tickets, and every other route stays operator-only. Operators whose Google account is linked the same way get My tickets too.
