# Project memory

## Sub-features

- Worker writes a memory entry via MCP `project_memory_write`; reads via `project_memory_read`
- Dashboard Memory tab lists entries (count in tab name)

## How to get to it (user POV)

Project page → Memory tab.

## Driving it with the harness

1. `say` a message, then `bun verify/drive.ts work "done" --memory "Theme tokens live in index.css"`.
2. `curl -s localhost:18080/projects/<id>/memory` → entry with that content, `type:"worker_note"`.
3. Dashboard: `snapshot -i` shows tab `Memory 1`; `click @<Memory tab ref>` · `snapshot` contains `Theme tokens live in index.css`. Screenshot.

Proves it: entry exists via API and renders in the Memory tab.

## Gotchas

- The MCP write needs `type` and `title`; drive.ts sends `worker_note` and the first 40 chars as title.
- Before any write the tab reads `Memory 0`.
