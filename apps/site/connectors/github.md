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

For the person who runs project-os. Values go into `.env`.

GitHub uses a **GitHub App**, not an OAuth App. A GitHub App's user tokens are limited to the repos the app is installed on, intersected with what the person can access, and they expire after 8 hours and refresh. GitHub Apps ignore OAuth scopes: what the token can do is set by the app's permissions below.

### Create the app

1. Go to GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**. To own it from an organization, use the organization's **Settings → Developer settings** instead.
2. Fill in:

   | Field                                                  | Value                                                                                          |
   | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
   | GitHub App name                                        | Anything unique, e.g. `project-os-<yourname>`                                                  |
   | Homepage URL                                           | Your `PUBLIC_URL`, e.g. `http://localhost:8080`                                                |
   | Callback URL                                           | `<PUBLIC_URL>/api/auth/callback/github`, e.g. `http://localhost:8080/api/auth/callback/github` |
   | Expire user authorization tokens                       | **On** (default). Better Auth refreshes them.                                                  |
   | Request user authorization (OAuth) during installation | Off. People link through `/connect`.                                                           |
   | Enable Device Flow                                     | Off                                                                                            |
   | Webhook → Active                                       | **Off**. project-os doesn't receive GitHub webhooks.                                           |
   | Where can this GitHub App be installed?                | **Only on this account**, unless repos live in other accounts or orgs                          |

3. **Permissions**. Pick what you want Workers to be able to do. The token can never exceed both these and the person's own access.

   | Permission                 | Level                                                            | Why                                                              |
   | -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
   | Repository → Metadata      | Read-only (always on)                                            | Required by GitHub                                               |
   | Repository → Contents      | Read-only, or **Read and write** if Workers should push branches | Clone and read code                                              |
   | Repository → Pull requests | Read-only, or **Read and write** if Workers should open PRs      | Read and open PRs                                                |
   | Repository → Issues        | Read-only, or Read and write                                     | Read and comment on issues                                       |
   | Account → Email addresses  | Read-only (optional)                                             | Shows the person's email; without it a `noreply` address is used |

   Start with read-only. You can raise a permission later, and each installation owner then has to accept the change.

4. Click **Create GitHub App**.

### Get the client credentials

On the app's **General** page:

1. Copy the **Client ID** (starts with `Iv`). It is not the App ID.
2. Under **Client secrets**, click **Generate a new client secret** and copy it.

```sh
GITHUB_CLIENT_ID=Iv...
GITHUB_CLIENT_SECRET=...
```

You don't need the app's private key. project-os only uses user tokens.

### Install the app on your repos

On the app page, click **Install App**, choose the account or organization that owns the repos, and select **Only select repositories** (or all). A person's token only reaches repos this installation covers. Install it on each account or org whose repos Workers should see.

Then [turn on account linking](../guide/setup.md#turn-on-account-linking).
