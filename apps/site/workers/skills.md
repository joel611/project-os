# How skills reach a worker

A worker is an AI agent (Claude, Pi or Codex). A **skill** is a folder with a `SKILL.md` and optional files that teaches the agent how to do one kind of work. Project OS gets skills to a worker in two separate ways.

| | Task type skills | Built-in Project OS skills |
| --- | --- | --- |
| What they teach | The work itself: development, research, writing, whatever you build | How to use Project OS: tickets, project memory, accounts |
| Who chooses them | An operator builds them; the decision model picks one per ticket | Nobody. Every worker sees the same set |
| How they arrive | Zipped, downloaded and unpacked **before** the ticket starts | Read **on demand** over the Coordinator's `/mcp` |
| Status | Stable | Experimental, off by default |

## Task type skills

A **task type** is a named group of skills, such as "development". Operators build task types on the dashboard's **Task types** page. Each one has a description of what requests it is for, and optional instructions on how the worker should use its skills.

### From skills.sh to R2

1. An operator adds skills to a task type from [skills.sh](https://skills.sh). skills.sh only lists them, so the Coordinator reads each skill's folder straight from its GitHub repo. It uses a connected shared GitHub account first, then `SKILLS_GITHUB_TOKEN`, then anonymous access (60 requests an hour).
2. Each skill is stored as one zip in file storage (R2 on Cloudflare), pinned to the folder's git tree SHA. Nothing changes until an operator clicks **Update**, which fetches only the folders whose SHA changed upstream.

Skills are written by third parties and run with the worker's access, so only operators can add them. The worker prompt also tells the agent to treat them as guidance that never overrides its rules.

### From a ticket to a running worker

1. A new request comes in. The decision model reads the descriptions of the task types that have skills and picks one, or none. The ticket records its task type, and the ticket page shows it.
2. A worker claims the ticket. Before the agent starts, the worker asks the Coordinator for the ticket's skills with its own token. Only the ticket's own worker can read them.
3. The Coordinator merges the task type's zips into one archive and returns it. `204 No Content` means the ticket has no skills, and the session starts normally.
4. The worker unpacks the archive and starts the agent with the skills in view. The task type's instructions are added to the agent's system prompt after the rules.
5. When the session ends, a Watcher removes the unpacked folder.

If the download or unpack fails, the session still starts without skills.

### Where they land

| Worker | What happens |
| --- | --- |
| [Local computer](local.md) running Claude | Unpacked into a private folder for that one session and loaded with `--add-dir`. Nothing is written to your own agent config |
| [Local computer](local.md) running Pi | Same private folder, each skill passed with `--skill` |
| Local computer running Codex | No skills are installed. Codex can't load skills from outside its config |
| [Cloud sandbox](cloud-sandbox.md) | The sandbox downloads the archive and unpacks it into `~/.pi/agent/skills` before Pi starts |

::: warning Not yet checked against live agents
The Claude and Pi paths above are covered by tests but have not been tried against a live agent session.
:::

### Turning it off

Set `WATCHER_SKILLS=0` on a Watcher computer to stop it installing task type skills. See [environment variables](../reference/environment.md#skills).

## Built-in skills over MCP (experimental)

Project OS also ships skills about itself: `project-os-tickets`, `project-os-memory` and `project-os-accounts`. They are bundled with the Coordinator, so there is nothing to store, sync or choose. When `EXPERIMENTAL_MCP_SKILLS=true`, a worker reads them from `/mcp` while it works, instead of getting them in the pre-ticket download.

No worker agent reads MCP skill resources natively yet, so today they arrive through two tools, `skill_list` and `skill_read`. The worker prompt tells a worker that has `skill_list` to read them first. They are also served as `skill://` resources, following the MCP [Skills extension](https://modelcontextprotocol.io/seps/2640-skills-extension).

Details and the flag are in [environment variables](../reference/environment.md#built-in-skills-over-mcp-experimental).
