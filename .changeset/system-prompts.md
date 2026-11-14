---
"@project-os/system-prompts": minor
"@project-os/agent-runtime": minor
"@project-os/core": patch
"@project-os/sandbox-core": minor
"@project-os/coordinator": patch
"@project-os/watcher": patch
---

Move every LLM prompt into the new `@project-os/system-prompts` package: the Worker session start (formerly `apps/watcher/prompts/session-start.md`), the Coordinator's project and admin session instructions, the Sidekick instructions, the Channel Digest instructions and request, the Jev intent and executor criteria, and the completed-ticket and status-question turns. Project and admin Pi sessions now get system instructions; until now they had none. Conversations created before this keep running without them. `makeAgentRuntime` no longer takes `instructions`, `digestPrompt` and `SIDEKICK_INSTRUCTIONS` are no longer exported from `@project-os/agent-runtime`, and the sandbox launcher no longer takes `prompt`.
