# @project-os/pi-acp

## 0.1.0

### Minor Changes

- [`558ac03`](https://github.com/joel611/project-os/commit/558ac035b2372dd2999b5615ee792227913ea2eb) Thanks [@joel611](https://github.com/joel611)! - Run Pi over ACP. A new `@project-os/pi-acp` package is an Agent Client Protocol agent that embeds Pi through its SDK and registers the MCP servers from `session/new` (HTTP with headers) on that one session, without touching `~/.pi/agent/mcp.json`. A Watcher with `WATCHER_PI_ACP=1` (command override `WATCHER_PI_ACP_COMMAND`, default `pi-acp`) drives Pi through it, so Pi's run log is structured like Claude's: messages, tool calls, tool results and errors. Off by default; sandbox sessions still run `pi --print`.

### Patch Changes

- [`66cbc84`](https://github.com/joel611/project-os/commit/66cbc84c919957d721213d0117f1c29b0df3e53e) Thanks [@joel611](https://github.com/joel611)! - A Pi turn whose model call fails (a bad key, a provider outage after Pi's retries) now fails the ACP prompt with Pi's error message, so the Watcher records the run as failed instead of succeeded.
