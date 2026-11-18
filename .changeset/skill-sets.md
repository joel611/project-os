---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/db-sqlite": minor
"@project-os/agent-runtime": minor
"@project-os/system-prompts": minor
"@project-os/sandbox-core": minor
"@project-os/infra-local": minor
"@project-os/infra-cloudflare": minor
"@project-os/web": minor
"@project-os/watcher": minor
---

Add skill sets. An Operator creates a set in the dashboard (e.g. "development"), downloads chosen skills from skills.sh into it, and clicks Update to fetch newer versions; a skill is pinned to the git tree SHA it was downloaded at until then, and stored as a zip in file storage (R2), so adding skills needs file storage configured. Jev gets a new question when any set has skills and picks a set for a new request (stored as `tickets.skill_set_id`, migration 0005). Before the ticket starts, a sandbox session pulls its set as one zip from `GET /tickets/:id/skills` with its own token, unzips it for Pi, and a Watcher unzips it into to a private folder for that one session (Claude Code and Pi; `WATCHER_SKILLS=0` turns it off). The Watcher now starts one session per assigned ticket, naming the ticket in the prompt. `SKILLS_GITHUB_TOKEN` raises GitHub's anonymous rate limit.
