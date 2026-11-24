---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/db-sqlite": patch
"@project-os/web": minor
---

Record the Coordinator's own errors and export them. An error a route throws, or a failed health sweep or Channel Digest Cron job, is written to the audit log as a `runtime_error` row (action `raised`) with the place, the error, a masked stack and a fingerprint; the same error from the same place is kept once an hour. The Audit page has a new Errors filter and an "Export incident report" button (last 24 hours or 7 days, for all projects or the project's tab) that downloads a Markdown file of the errors, failed or blocked tickets, Worker outages and digest or classifier failures, from `GET /audit/report`, so it can be posted to the project's Discord channel. Needs the `audit:read` permission (admins).
