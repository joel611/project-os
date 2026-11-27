# GitHub

Connect GitHub so project-os can answer questions using your code.

## What you can do

- **Add a repository as a project source** with `/source-add`.
- **Ask quick questions** about a repository's status, history, pipelines, or releases. These are read only and do not need a worker.
- **Hand over deeper work.** Anything that needs the whole repository, tests, or a script goes to a cloud sandbox or local worker.
- **Hear when work is merged.** When a pull request linked in a worker's result is merged, project-os posts a notice in the ticket's thread.

## Access

Run `/connect` and choose GitHub. With your own account, project-os reaches only repositories that both you and your team's GitHub App can access. The app's permissions decide whether a worker can only read, or can also push branches and open pull requests.

## Set up

To create the app, follow [GitHub App setup](../guide/setup.md#_3-github-app).
