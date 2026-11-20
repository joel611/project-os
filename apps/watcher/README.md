# Watcher

Runs on your own computer. It polls the Coordinator for Tickets assigned to this device and starts an agent session (`claude`, `pi`, or `codex`) for each. It talks to the Coordinator only, over MCP at `<server>/mcp`.

## Quick start

```sh
# 1. Get a code from the /register-worker command in Discord.
# 2. Register this computer, then the Watcher starts running.
project-os-watcher register <code> --server https://coordinator.example.com

# Later runs use the saved registration.
project-os-watcher
```

From the repo: `bun run start` in `apps/watcher` (same as `bun src/main.bun.ts`). It runs on the host with Bun, not in Compose. It refuses to run unregistered.

A code from `/register-worker` makes this computer your personal worker. A code an admin made with `/register-worker shared:True` adds it to the pool as a shared worker for everyone.

## Commands

| Command                                  | What it does                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-os-watcher`                     | Run: poll for Tickets and start an agent session for each. Polls once at start, then every poll interval.                                                            |
| `project-os-watcher register <code> ...` | Register this computer, save the credentials, then run.                                                                                                              |
| `project-os-watcher uninstall [--yes]`   | Stop the Watcher, uninstall the package, delete the saved registration and Pi's Coordinator MCP entry. Asks first unless `--yes` / `-y`. Needs a terminal to ask on. |
| `project-os-watcher --help`              | Print usage. `-h` and `help` also work.                                                                                                                              |

### `register` arguments

| Argument          | Required | Meaning                                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `<code>`          | yes      | Code from `/register-worker`.                                                                      |
| `--server <url>`  | yes\*    | Coordinator base URL. \*Falls back to `PROJECT_OS_URL` when omitted.                               |
| `--name <name>`   | no       | Display name for this device. Defaults to the worker id.                                           |
| `--agent <agent>` | no       | `claude`, `pi`, or `codex`. Saved with the registration. Default `claude`.                         |
| `--model <model>` | no       | Passed to the agent as `--model`. Saved with the registration. Unset uses the agent's own default. |

## Environment variables

Read at run time. Where one overrides a saved choice, it applies to that run only.

| Variable                  | Default                                                    | Meaning                                                                          |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `WATCHER_AGENT`           | saved agent                                                | Force `claude`, `pi`, or `codex`. Any other value is an error.                   |
| `WATCHER_MODEL`           | saved model                                                | Model for the agent. A saved model only follows the agent it was saved with.     |
| `WATCHER_SKILLS`          | on                                                         | `0`, `false`, or `off` skips installing the Ticket's skill set before a session. |
| `POLL_INTERVAL_MS`        | `300000` (5 minutes)                                       | Time between polls. This is the pickup latency for a new Ticket.                 |
| `MAX_SESSIONS`            | `1`                                                        | Agent sessions this Watcher runs at once.                                        |
| `WORKER_CWD`              | current directory                                          | Working directory for agent sessions.                                            |
| `PROJECT_OS_URL`          | none                                                       | `register` only: Coordinator URL when `--server` is omitted.                     |
| `PROJECT_OS_WATCHER_HOME` | `$XDG_CONFIG_HOME/project-os`, else `~/.config/project-os` | Directory holding the saved registration.                                        |

## Agent selection

1. `WATCHER_AGENT`, if set.
2. The agent saved at `register --agent`, if its command is on `PATH`.
3. The first installed agent of `claude`, `pi`, `codex`.
4. The saved agent, else `claude`, even if not installed.

When the saved agent is missing and falls through, the Watcher logs `saved agent X isn't installed; using Y instead`.

## Saved registration

`register` writes `watcher.json` in the config directory (`~/.config/project-os/watcher.json` by default) with mode `0600`. It holds the Coordinator URL, worker id, name, the bearer secret for `/mcp`, and the saved agent and model. Delete it, or run `uninstall`, to unregister. Re-run `register` with a new code to replace it.

## Files

- `src/cli.ts` argument parsing and `--help` text
- `src/config.ts` environment variables and agent selection
- `src/credentials.ts` saved registration
- `src/poll.ts` polling loop
- `src/spawn.ts` agent session launch
- `src/uninstall.ts` `uninstall`
