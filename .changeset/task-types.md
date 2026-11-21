---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/db-sqlite": minor
"@project-os/system-prompts": minor
"@project-os/sandbox-core": minor
"@project-os/web": minor
"@project-os/watcher": minor
---

Rename skill sets to task types (migration renames `skill_sets` to `task_types` and `skill_set_id` to `task_type_id`; the dashboard route moves from `/skill-sets` to `/task-types`). A task type now has an Instructions text area that is added to the Worker's system prompt, Watcher and sandbox sessions alike, whenever the ticket was routed to that type. The ticket page shows which task type it used.
