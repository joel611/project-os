---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/watcher": major
"@project-os/channel-discord": minor
"@project-os/config": minor
"@project-os/agent-runtime": minor
"@project-os/db-sqlite": patch
"@project-os/web": minor
---

Replace the hosted shared Watcher (`WORKER_ID`) with shared workers that admins register: `/register-worker shared:True` in the admin channel gives a one-time code, and the device joins the pool for everyone. Tickets go to the requester's own device, then a free shared device (`SHARED_WORKER_MAX_TICKETS`), then a sandbox; with none free they queue and the health sweep assigns them later. The Watcher now requires registration, `DEFAULT_WORKER_TYPE` and the classifier's `worker_type` are gone, and the dashboard groups workers into Shared pool, Personal and Sandbox sessions.
