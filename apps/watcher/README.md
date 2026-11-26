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

| Command                                  | What it does                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-os-watcher`                     | Run: poll for Tickets and start an agent session for each. Polls once at start, then every poll interval.                                                                                             |
| `project-os-watcher register <code> ...` | Register this computer, save the credentials, then run.                                                                                                                                               |
| `project-os-watcher uninstall [--yes]`   | Stop the Watcher, uninstall the package, delete the saved registration and Pi's Coordinator MCP entry. Keeps `workspaces/` and `logs/`. Asks first unless `--yes` / `-y`. Needs a terminal to ask on. |
| `project-os-watcher --help`              | Print usage. `-h` and `help` also work.                                                                                                                                                               |

### `register` arguments

| Argument          | Required | Meaning                                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `<code>`          | yes      | Code from `/register-worker`.                                                                      |
| `--server <url>`  | yes\*    | Coordinator base URL. \*Falls back to `PROJECT_OS_URL` when omitted.                               |
| `--name <name>`   | no       | Display name for this device. Defaults to the worker id.                                           |
| `--agent <agent>` | no       | `claude`, `pi`, or `codex`. Saved with the registration. Default `claude`.                         |
| `--model <model>` | no       | Passed to the agent as `--model`. Saved with the registration. Unset uses the agent's own default. |
| `--verbose`, `-v` | no       | Debug logging for this run. Also works on the run command with no `register`.                      |

## Environment variables

Read at run time. Where one overrides a saved choice, it applies to that run only.

| Variable                  | Default                                                    | Meaning                                                                          |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `WATCHER_AGENT`           | saved agent                                                | Force `claude`, `pi`, or `codex`. Any other value is an error.                   |
| `WATCHER_MODEL`           | saved model                                                | Model for the agent. A saved model only follows the agent it was saved with.     |
| `WATCHER_VERBOSE`         | off                                                        | `1`, `true`, or `on` is the same as `--verbose`.                                 |
| `WATCHER_SKILLS`          | on                                                         | `0`, `false`, or `off` skips installing the Ticket's task type before a session. |
| `POLL_INTERVAL_MS`        | `300000` (5 minutes)                                       | Time between polls. This is the pickup latency for a new Ticket.                 |
| `MAX_SESSIONS`            | `1`                                                        | Agent sessions this Watcher runs at once.                                        |
| `PROJECT_OS_URL`          | none                                                       | `register` only: Coordinator URL when `--server` is omitted.                     |
| `PROJECT_OS_WATCHER_HOME` | `$XDG_CONFIG_HOME/project-os`, else `~/.config/project-os` | The config directory: saved registration, workspaces and logs.                   |

## Workspaces

Each ticket gets its own folder, `<config dir>/workspaces/<ticket id>/`, created private (`0700`). Before a session starts, the Watcher lists the project's sources (`project_sources_list`) and clones each GitHub repo into `<alias>/`. The session starts in that checkout when the project has exactly one repo, else in the ticket's folder. The prompt tells the agent what is checked out where.

- **Auth.** A clone is tried anonymously first, so a public repo never asks the person to connect GitHub. Only when that fails does the Watcher ask the Coordinator for the requesting person's token (`user_token`) and retry. git runs with no system or global config, no credential helper, no `~/.netrc`, and no prompts, so this computer's own git login is never used: a shared worker serves other people. The token goes to git through the environment as an HTTP header, never in argv, the remote URL, `.git/config`, or the log.
- **Failures.** A repo that can't be cloned, or sources that can't be listed, don't stop the session. It starts in the ticket's folder and the prompt says which repos failed and why, so the agent can clone it itself or set the ticket to `blocked`.
- **Reuse.** A checkout that is already there is reused untouched, so a reopened ticket finds its earlier work, committed or not. A clone goes into a temporary sibling and is renamed into place, so a clone cut short is never reused. The Watcher never deletes a workspace: remove old ones yourself.

## Logging

Logs go to stdout through [pino](https://getpino.io), each line with a timestamp. A terminal gets colored output, fields on indented lines below (`[2026-11-20 15:20:04.123] INFO: session start (1/1) for t1`). A pipe or Docker gets JSON lines with an ISO `time`. The same entries are also appended as JSON lines to `<config dir>/logs/watcher.log` (mode `0600`). It is not rotated.

By default it logs startup, session start and exit with duration, skill installs, and failures. `--verbose` (or `WATCHER_VERBOSE=1`) adds each heartbeat, assigned-ticket list, MCP request status and timing, skill fetch result, and the agent launch (command, working directory, model). Secrets and the prompt are never logged.

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
- `src/workspace.ts` ticket workspaces and repo clones
- `src/uninstall.ts` `uninstall`
