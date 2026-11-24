---
"@project-os/coordinator": minor
---

Add a read-only admin MCP server at `/mcp/admin` so an admin's Claude can read live data to trace and debug production. Set `ADMIN_MCP_TOKEN` (at least 32 characters) to turn it on; without it the endpoint is not mounted. Tools cover projects and their sources and memory, tickets with their event logs, worker runs and transcripts (paged), workers, the audit log, the activity feed and members. There are no write tools, connector tokens and device secrets are never read, and every result is masked for credential-shaped strings and the Coordinator's own secrets. Worker, dashboard and service credentials are refused on the route, and the admin token is refused on `/mcp`.
