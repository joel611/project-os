---
"@project-os/auth": minor
"@project-os/coordinator": minor
"@project-os/web": minor
---

Add `GOOGLE_ALLOWED_DOMAINS` to limit dashboard sign-in with Google to Google Workspace domains. When it's set, anyone with a verified account at those domains may sign in without being listed, and every other Google account is refused, including `ADMIN_EMAILS` outside them. The `ADMIN_EMAIL` password sign-in still works. The login page names the allowed domains when Google refuses someone. Unset, nothing changes.
