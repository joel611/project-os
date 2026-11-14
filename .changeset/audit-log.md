---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/config": minor
---

Replace the inbound log with an append-only audit log. It records every message the Coordinator receives (admin-channel and unlinked-channel messages included, org-wide only), each Channel Digest run, Worker registration, removal, first heartbeat, going offline and coming back, and Ticket creation, assignment, claim, re-queue and status changes. `GET /audit` (org-wide, `kind` and `projectId` filters) and `GET /projects/:id/audit` replace `GET /projects/:id/inbound`; the dashboard gets an Audit log page and a project Audit tab in place of the Channel tab. Existing inbound log rows are migrated. Entries older than `AUDIT_RETENTION_DAYS` (default 90) are deleted by the health sweep.
