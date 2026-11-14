---
"@project-os/coordinator": minor
"@project-os/web": minor
"@project-os/core": minor
"@project-os/db-sqlite": minor
"@project-os/testing": minor
---

Each Worker gets a detail page in the dashboard (`/workers/:id`, opened from the sidebar): what it is, whether it is online and when it last checked in, the tickets it is working on now, every ticket assigned to it, and its own audit entries. New operator-only routes `GET /workers/:id` and `GET /workers/:id/audit`; the audit log can be filtered by Worker, with a new `audit_log_worker_idx` index.
