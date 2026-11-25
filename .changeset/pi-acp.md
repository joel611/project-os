---
"@project-os/pi-acp": minor
"@project-os/watcher": minor
---

Run Pi over ACP. A new `@project-os/pi-acp` package is an Agent Client Protocol agent that embeds Pi through its SDK and registers the MCP servers from `session/new` (HTTP with headers) on that one session, without touching `~/.pi/agent/mcp.json`. A Watcher with `WATCHER_PI_ACP=1` (command override `WATCHER_PI_ACP_COMMAND`, default `pi-acp`) drives Pi through it, so Pi's run log is structured like Claude's: messages, tool calls, tool results and errors. Off by default; sandbox sessions still run `pi --print`.
