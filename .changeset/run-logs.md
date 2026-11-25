---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/config": minor
"@project-os/watcher": minor
"@project-os/web": minor
---

Keep what Workers did. Each agent session on a Ticket is now a Run: the Watcher pipes the agent's output (Claude Code runs with its structured stream, so messages, tool calls, tool results and errors are separate events; Pi and Codex are kept as plain lines), masks secrets on the device and again on the Coordinator, and uploads it to `POST /tickets/:id/runs` in numbered chunks, saving what it can't deliver and retrying on the next poll. Sandbox sessions are recorded from the output the launcher already receives. Transcripts live in file storage, the summary in a new `ticket_runs` table, and the audit log gets `run_started` and `run_finished`. The ticket page has a Runs section with search, event-type filters and a JSONL download; admins see every Run and a requester sees the Runs of their own Tickets. Transcripts are deleted after `RUN_LOG_RETENTION_DAYS` (default 30). A Watcher keeps its transcripts on the computer with `--no-run-log` or `WATCHER_RUN_LOG=0`.
