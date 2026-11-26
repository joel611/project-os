# Local computer

Computers running the Watcher take tickets after they register with a one-time code. There are two kinds:

- **Personal:** a developer's own computer. It works only on the tickets they start.
- **Shared:** a computer an admin adds to the pool. It works on anyone's tickets.

Coordinator `.env`:

```sh
# Where people's computers reach the Coordinator (the Watcher registers and polls here).
# Same value as for account linking; must be reachable from their machines, so a tunnel or public host.
PUBLIC_URL=https://coordinator.example.com

# Tickets one shared computer holds at once before the next goes to another one or a sandbox.
# Match the Watcher's MAX_SESSIONS on those computers. Default 1.
SHARED_WORKER_MAX_TICKETS=1

# Optional: how people install the Watcher. Default: bun install -g @project-os/watcher
# The package isn't on npm yet, so until it is, point this at something that installs it.
WATCHER_INSTALL_COMMAND=
```

Then, for each person's own computer:

1. Run `/register-worker` in any server channel (optionally `name:my-laptop`). The reply is private.
2. Paste the command it shows on the computer that should do the work. It is `curl -fsSL <PUBLIC_URL>/watcher/install.sh | sh -s -- <code>`, so the computer needs Bun, `curl`, and at least one signed-in agent CLI (`claude`, `pi` or `codex`). The script lists the agents it finds, asks which one should work your tickets and which model (Enter keeps the agent's default), installs the Watcher with `WATCHER_INSTALL_COMMAND`, and registers it. To skip the questions, run `/register-worker agent:codex model:gpt-5` (`model` is optional; without it the agent's default is used): the line it prints carries `--agent`, `--model` and `--yes`. By hand, pass `--agent <name>` or `--model <model>` after the code to skip one question, or `--yes` to skip all of them (it uses the first agent found unless `--agent` is set). The code works once, for 10 minutes.
3. The Watcher saves its credentials, agent and model in `~/.config/project-os/watcher.json` and keeps running. Start it again later with `project-os-watcher`. The agent is picked at every start: the saved one if its CLI is still installed, otherwise the first of `claude`, `pi`, `codex` that is (with its saved model dropped, and a line in the log). `WATCHER_AGENT` and `WATCHER_MODEL` override all of that for one run. The Coordinator sees every such computer as a `local` worker, whatever agent it runs. `project-os-watcher --help` lists the commands.
   The Watcher keeps one clone of each of the project's GitHub repos in `~/.config/project-os/workspaces/repos/<owner>/<name>/`, on its default branch. Each ticket's session starts in its own folder, `~/.config/project-os/workspaces/tickets/<ticket id>/`, with a git worktree of each repo at `<alias>/` on the branch `ticket/<ticket id>`, made from the default branch as just fetched (the session starts in the worktree itself when the project has just one repo). Public repos are cloned and fetched anonymously; a private one uses the requesting person's GitHub connection, never this computer's own git login, and that fetch also checks the person can read the repo before they get a worktree of it. A clone or fetch that takes longer than `WATCHER_GIT_TIMEOUT_MS` is stopped. A repo that can't be checked out doesn't stop the session: the agent is told which one failed and why. The worktree is kept when the ticket ends, so a reopened ticket picks up its earlier work. Once the ticket is completed and every PR its result names is merged, the Watcher removes its worktrees that hold no uncommitted or untracked files; anything else stays. The Watcher's log also goes to `~/.config/project-os/logs/watcher.log`, and each session's events to their own file in `~/.config/project-os/logs/sessions/<ticket id>/`, even with `--no-run-log`.
4. `/workers` lists your computers, and the shared ones, and whether they're online. `/unregister-worker worker:<name>` removes one of yours.
5. To take the Watcher off a computer, run `project-os-watcher uninstall` there (add `--yes` to skip the question). It stops running Watchers, removes the package, deletes `watcher.json` and `mcp.json` from `~/.config/project-os`, and drops the Coordinator from `~/.pi/agent/mcp.json`. It keeps `workspaces/` and `logs/` there, since a workspace may hold uncommitted or unpushed work and `logs/sessions/` holds the session logs; delete them yourself when you're done. Then run `/unregister-worker` so the Coordinator stops listing it.

For a shared computer, an admin (in `ADMIN_USER_IDS`) does the same in the admin channel with `shared:True`: `/register-worker shared:True name:build-box`, then pastes the command on that computer. `/workers shared:True` lists the shared computers and `/unregister-worker shared:True worker:<name>` removes one. Both kinds show in the dashboard sidebar under Workers.

A computer counts as online if it checked in within `HEALTH_WORKER_STALE_MIN` (15 minutes by default; it checks in every 5).
