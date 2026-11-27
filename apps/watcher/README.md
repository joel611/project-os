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

| Variable                  | Default                                                    | Meaning                                                                              |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `WATCHER_AGENT`           | saved agent                                                | Force `claude`, `pi`, or `codex`. Any other value is an error.                       |
| `WATCHER_MODEL`           | saved model                                                | Model for the agent. A saved model only follows the agent it was saved with.         |
| `WATCHER_VERBOSE`         | off                                                        | `1`, `true`, or `on` is the same as `--verbose`.                                     |
| `WATCHER_SKILLS`          | on                                                         | `0`, `false`, or `off` skips installing the Ticket's task type before a session.     |
| `POLL_INTERVAL_MS`        | `300000` (5 minutes)                                       | Time between polls. This is the pickup latency for a new Ticket.                     |
| `MAX_SESSIONS`            | `1`                                                        | Agent sessions this Watcher runs at once.                                            |
| `WATCHER_GIT_TIMEOUT_MS`  | `600000` (10 minutes)                                      | How long a `git clone` or `git fetch` of a project repo may run before it is killed. |
| `PROJECT_OS_URL`          | none                                                       | `register` only: Coordinator URL when `--server` is omitted.                         |
| `PROJECT_OS_WATCHER_HOME` | `$XDG_CONFIG_HOME/project-os`, else `~/.config/project-os` | The config directory: saved registration, workspaces and logs.                       |

## Workspaces

Everything lives under `<config dir>/workspaces/`, created private (`0700`):

- `repos/<owner>/<name>/`: one clone of each GitHub repo, on its default branch, shared by every ticket.
- `tickets/<ticket id>/<alias>/`: a git worktree of that clone for one ticket, on the branch `ticket/<ticket id>`.

Before a session starts, the Watcher lists the project's sources (`project_sources_list`). For each GitHub repo it clones the repo if this computer has no clone yet, else fetches it. Then it adds the ticket's worktree on `ticket/<ticket id>`: a new branch from the default branch just fetched (not tracking it), or the branch as it is when the ticket already has one. The session starts in that worktree when the project has exactly one repo, else in the ticket's folder. The prompt tells the agent what is checked out where, and on which branch.

- **Auth.** A clone or fetch is tried anonymously first, so a public repo never asks the person to connect GitHub. Only when that fails does the Watcher ask the Coordinator for the requesting person's token (`user_token`) and retry. The fetch before each new worktree is also the access check: a clone made with one person's token never gives files to someone who can't read the repo. git runs with no system or global config, no credential helper, no `~/.netrc`, and no prompts, so this computer's own git login is never used: a shared worker serves other people. The token goes to git through the environment as an HTTP header, only for clone and fetch, never in argv, the remote URL, `.git/config`, or the log.
- **A clone agents can write to.** Sessions share each clone, so the Watcher's own git commands don't trust its `.git/config` or hooks. They fetch `https://github.com/<owner>/<name>.git` itself with an explicit refspec, not whatever `origin` says, and force, over the repo's own settings: no hooks, no fsmonitor, no credential helper or askpass, TLS verification on, no proxy but the environment's, https only. A clone whose config rewrites that URL (`url.*.insteadOf`, `remote.<url>.*`) is not fetched; the prompt and log say so.
- **Timeouts.** A clone or fetch that runs longer than `WATCHER_GIT_TIMEOUT_MS` is killed with every process it started, leaves no partial folder, and is not retried with the token.
- **Failures.** A repo that can't be checked out, or sources that can't be listed, don't stop the session. It starts in the ticket's folder and the prompt says which repos failed and why, so the agent can clone it itself or set the ticket to `blocked`.
- **Reuse.** A worktree that is already there is reused untouched, so a reopened ticket finds its earlier work, committed or not. Clones and worktrees are made in a temporary folder and moved into place, so one cut short is never used. A worktree folder someone deleted is made again on the ticket's branch.
- **Cleanup.** At each poll, for every ticket folder with no session running, the Watcher reads the ticket (`ticket_get`). Once the ticket is `completed`, its Worker reported at least one PR in a `result`, and the Coordinator has recorded every one of those PRs as merged, the Watcher removes the ticket's worktrees with `git worktree remove` (never forced), deletes the ticket's branch only where `git branch -d` agrees it is merged, and removes the ticket's folder once it is empty. A worktree with changed or untracked files, and anything else in the folder, stays and is logged as a warning. Clones stay. A ticket the Watcher can't read any more (reassigned, stopped) keeps its folder. A reopened ticket gets a new worktree on its branch.

## Logging

Logs go to stdout through [pino](https://getpino.io), each line with a timestamp. A terminal gets colored output, fields on indented lines below (`[2026-11-20 15:20:04.123] INFO: session start (1/1) for t1`). A pipe or Docker gets JSON lines with an ISO `time`. The same entries are also appended as JSON lines to `<config dir>/logs/watcher.log` (mode `0600`). It is not rotated.

By default it logs startup, session start and exit with duration, skill installs, workspace checkouts and cleanups, and failures. `--verbose` (or `WATCHER_VERBOSE=1`) adds each heartbeat, assigned-ticket list, MCP request status and timing, skill fetch result, and the agent launch (command, working directory, model). Secrets and the prompt are never logged.

Each agent session also gets its own file, `<config dir>/logs/sessions/<ticket id>/<start time>-<run id>.log` (folders `0700`, files `0600`): one JSON line per event of the session, the same events the run log sends the Coordinator, with the same secrets masked (this device's secret, tokens and keys from the environment, and the person's GitHub token). It is written even with `--no-run-log`, so the agent's output is always read by the Watcher and shown on the terminal from there. A file that can't be written never fails the session. Session logs are never rotated or deleted, not even by cleanup.

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
- `src/poll.ts` polling loop, and cleanup of merged tickets' workspaces
- `src/spawn.ts` agent session launch
- `src/workspace.ts` shared repo clones, ticket worktrees, and their cleanup
- `src/git.ts` running git with a timeout
- `src/run-log.ts` a session's event stream, and its upload to the Coordinator
- `src/session-log.ts` a session's own log file
- `src/uninstall.ts` `uninstall`
