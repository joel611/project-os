---
name: verify-project-os
description: Launch and drive project-os (Coordinator HTTP+MCP, Discord→Ticket→Worker→reply loop, read-only web dashboard) locally and capture proof. Use to verify any change to apps/coordinator, channel-discord, watcher, web, or packages/*, beyond `bun run test:integration`.
---

# verify-project-os

Surfaces: **Coordinator** (Elysia, HTTP `/inbound` `/projects` `/tickets` `/workers`, MCP `/mcp`, SQLite) and **web dashboard** (`apps/web`, read-only, proxies `/api/*` → Coordinator). Discord and Claude Code are not drivable here; their production boundaries are stood in for (below). Read `features/README.md` for the per-feature recipes.

## What is real vs faked

Real: SQLite (fresh file), Coordinator HTTP + MCP, `normalizeMessage` + `/inbound` forwarding, MCP SDK worker client, Vite dashboard, browser.
Faked (production boundaries to external systems): intent classifier (always `new_request`, no OpenRouter), agent runtime (echo), Discord reply endpoint (appends to `$VERIFY_DIR/data/posted.jsonl` instead of posting to Discord), and the Claude Code session (`drive.ts work` plays `apps/watcher/prompts/session-start.md` over real MCP). Not covered: the real Watcher poll loop / `claude -p` spawn, discord.js, LLM replies, email adapter, Cloudflare target. The real `main.bun.ts` needs `OPENROUTER_API_KEY`+`CHAT_MODEL_ID`, hence the scaffold launcher `apps/e2e/verify/serve.ts` (verification scaffolding; lives in apps/e2e only so workspace deps resolve).

## Launch

```sh
.claude/skills/verify-project-os/run.sh up      # ~10s; from empty data dir
```

Ready = prints `READY coordinator=… project=<id> worker=<shared-…>` then `WEB http://localhost:15173`. It creates org `verify-org`, project **Verify Project**, default Discord channel `verify-chan`, a shared worker **verify-box** (registered as an admin's `/register-worker shared:True` would; credentials in `$VERIFY_DIR/data/worker.json`) and an offline personal device **bob-laptop**. Defaults: Coordinator `:18080`, reply endpoint `:18081`, web `:15173`, state in `/tmp/project-os-verify-18080` (`VERIFY_DIR`). Override with `COORD_PORT ADAPTER_PORT WEB_PORT VERIFY_DIR`; use all different values for a second side-by-side instance. `up` refuses if any port is already taken — never double-drive an instance you didn't start. Needs `bun install` done in the checkout (worktrees: run it first).

## Doctor

`run.sh doctor` — read-only; checks pid alive, port owned by our pid, `/health`, seed project, MCP `tools/list`, dashboard `/api` proxy. Exit 1 on any FAIL; run it first whenever anything looks off.

## Drive

Everything below runs from `apps/e2e` (`cd apps/e2e`) with `DATA_DIR=$VERIFY_DIR/data` exported (drive.ts reads the shared worker's credentials there); scripts: `verify/drive.ts`.

| Action                                             | Command                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Discord user speaks                                | `bun verify/drive.ts say "please add dark mode" [--channel verify-chan --user u1 --name Ada]`                          |
| Worker completes oldest assigned ticket            | `bun verify/drive.ts work "added dark mode toggle" [--memory "fact to store"]`                                         |
| Worker checks in (what the Watcher does each poll) | `bun verify/drive.ts heartbeat`                                                                                        |
| Read state                                         | `curl -s localhost:18080/projects`, `…/projects/<id>/tickets`, `…/tickets/<id>`, `…/projects/<id>/memory`, `…/workers` |
| Reply Discord would get                            | `cat $VERIFY_DIR/data/posted.jsonl`                                                                                    |

`work` fails loudly if nothing is assigned. Project id: `curl -s localhost:18080/projects` (or the `project=` in the READY line).

The API refuses calls without credentials. Every `curl` read above needs the operator's session: `-H "authorization: Bearer $(cat $VERIFY_DIR/data/operator.token)"`. A hand-made `POST /inbound` needs the service token instead: `$(cat $VERIFY_DIR/data/service.token)`.

Dashboard via `agent-browser` (skill `agent-browser`); URL `http://localhost:15173/projects/<projectId>`. Use snapshot refs, not coordinates. Any page redirects to `/login` until you sign in, so sign in first with the `login=` email and password from the READY line. "Continue with Google" also works: it signs in as `ada@example.com` through a fake Google that serve.ts runs on localhost.

```sh
agent-browser open http://localhost:15173/login && agent-browser snapshot -i   # textboxes "Email", "Password"; button "Sign in"
agent-browser fill @<Email ref> verify@project-os.test && agent-browser fill @<Password ref> verify-password && agent-browser click @<Sign in ref>
agent-browser open http://localhost:15173/projects/<projectId> && agent-browser wait 2000
agent-browser snapshot -i          # tabs "Tickets N" / "Memory N"; rows "<Status><title><worker><age>"; ticket title is a link
agent-browser click @<ticket link ref>   # opens dialog "<ticket title>" with Activity timeline + Result
agent-browser press Escape
agent-browser click @<Memory tab ref>
```

`find role row --name …` does not match rows (row names are empty); use refs from `snapshot -i`. The dashboard polls every few seconds: `wait 6000` after a state change before snapshotting.

## Evidence

Save to `$VERIFY_DIR/evidence/` (default `/tmp/project-os-verify-18080/evidence/`). For each feature capture: the action's command + output, the API read-back (`curl` JSON), the side-effect (`posted.jsonl`, memory rows), and an ARIA snapshot + screenshot of the dashboard showing the resulting state. Proof standards: drive `say` (real `/inbound` path) and `work` (real MCP) — never insert rows or call status endpoints directly to fake progress; verify side effects (reply recorded, memory stored) alongside the UI; the AI/Discord fakes above are the only mocks. Always also run `bun run test:integration` from the repo root for a change to any app/package (project rule).

## Cleanup

`run.sh down` — kills the recorded pids and any listener left on our three ports (only if `up` ran), deletes `data/`, pids, logs. **Evidence is kept** in `$VERIFY_DIR/evidence`. Run it after every failed attempt too. Never `pkill bun`/`pkill vite`.

## Known limits

- The shared worker shows offline ("seen never") until `drive.ts heartbeat` runs (the real Watcher does this each poll), and new tickets queue until then; it flips to offline again after the stale window. See `features/worker-health.md`.
- Fixed ports mean one instance per port set; classifier is hard-wired, so low-confidence / admin-channel paths are covered only by `apps/e2e` tests.
