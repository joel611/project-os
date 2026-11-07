# Setup

How to connect project-os to Discord, Google Drive, and GitHub, step by step, with the exact permissions each one needs. For what the system does, see [`README.md`](README.md).

You need three things working, in this order:

| Step                                                 | What it gives you                                                                                          | Required?         | `.env` keys                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| [1. Discord bot](#1-discord-bot)                     | The bot hears messages, replies, creates project channels and ticket threads                               | Yes               | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PROJECT_CATEGORY_ID`, `ADMIN_CHANNEL_ID`, `ADMIN_USER_IDS` |
| [2. Google Drive](#2-google-drive-oauth-client)      | Each person links their own Google account, so Workers read Drive with that person's access                | Optional          | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                   |
| [3. GitHub](#3-github-app)                           | Each person links their own GitHub account, so Workers use `gh` / `git` with that person's access          | Optional          | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                                                   |
| [4. Account linking](#4-turn-on-account-linking)     | Turns on `/connect` for steps 2 and 3                                                                      | If you did 2 or 3 | `BETTER_AUTH_SECRET`, `PUBLIC_URL`                                                                           |
| [5. Personal workers](#5-personal-workers)           | People run `/register-worker` to use their own computer as their Worker; others get a sandbox              | Optional          | `PUBLIC_URL`, `DEFAULT_WORKER_TYPE`, `WATCHER_INSTALL_COMMAND`                                               |
| [6. Cloud sandbox workers](#6-cloud-sandbox-workers) | The Coordinator runs each shared ticket in a Daytona, Cloudflare or boat.dev sandbox, from a pool you pick | Optional          | `WORKER_PROVIDERS`, `SANDBOX_MCP_URL`, `DAYTONA_API_KEY`, `CLOUDFLARE_SANDBOX_URL`, `BOAT_API_KEY`           |

Start with:

```sh
bun install
cp .env.example .env
```

Every value below goes into `.env`. Docker Compose reads it for the Coordinator, which runs the Discord bot in the same process, and the Watcher reads it from your shell.

Workers never use a shared Google or GitHub credential. They call the `user_token` MCP tool, which returns the token of the person who asked, so Google's and GitHub's own permissions decide what a Worker can reach.

---

## 1. Discord bot

### 1.1 Create the application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it (this is the bot's display name).
2. On **General Information**, copy the **Application ID**. You need it for the invite link.
3. Go to **Bot**:
   1. Click **Reset Token**, copy it, and put it in `.env` as `DISCORD_BOT_TOKEN`. Discord shows it once.
   2. Under **Privileged Gateway Intents**, turn on **Message Content Intent** and save. Without it the bot receives messages with empty text and can't see @mentions.
   3. Leave **Presence Intent** and **Server Members Intent** off. They aren't used.
   4. Optional: turn off **Public Bot** so only you can add it to servers.

The bot connects with these gateway intents (`packages/channel-discord/src/main.bun.ts`):

| Intent           | Privileged                     | Why                                             |
| ---------------- | ------------------------------ | ----------------------------------------------- |
| `Guilds`         | No                             | See servers, channels, and threads              |
| `GuildMessages`  | No                             | Receive messages in server channels and threads |
| `MessageContent` | **Yes** (toggle in the portal) | Read message text and @mentions                 |

### 1.2 Invite the bot to your server

The invite needs two **scopes**:

| Scope                   | Why                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bot`                   | Adds the bot user to the server                                                                                                          |
| `applications.commands` | Lets the bot register `/project-create`, `/connect`, `/disconnect`, `/connections`, `/register-worker`, `/workers`, `/unregister-worker` |

And these **bot permissions**:

| Permission               | Used for                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| View Channels            | See project channels and the admin channel                                                                            |
| Send Messages            | Post replies in channels                                                                                              |
| Read Message History     | Fetch the message a ticket thread is started from                                                                     |
| Manage Channels          | Create a channel for each new project (`/project-create`, admin `create project`)                                     |
| Create Public Threads    | Open a thread for each new ticket                                                                                     |
| Send Messages in Threads | Post ticket updates and the final answer inside that thread                                                           |
| Add Reactions            | React 👀 on a message the bot accepted (from [PR #53](https://github.com/joel611/project-os/pull/53), not merged yet) |

Together these are permissions integer `309237714000`. Open this URL with your Application ID filled in, pick your server, and authorize:

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=309237714000
```

You can also build the same link in the portal under **OAuth2 → URL Generator** (or **Installation → Guild Install**) by ticking the scopes and permissions above.

If you'd rather not grant Manage Channels, set `DISCORD_PROJECT_CHANNEL_AUTO_CREATE=false` and link existing channels to projects instead. If threads are refused, tickets still work, the conversation just stays in the channel.

### 1.3 Copy the ids into `.env`

Turn on **Developer Mode** in Discord (User Settings → Advanced → Developer Mode). Then right-click to **Copy ID**:

| Right-click                         | `.env` key                    | Notes                                                                                                                                                   |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server icon → Copy Server ID    | `DISCORD_GUILD_ID`            | Where project channels are created. Also makes slash commands appear immediately; without it they register globally and can take up to an hour to show. |
| A category → Copy Channel ID        | `DISCORD_PROJECT_CATEGORY_ID` | Optional. New project channels go under it. The bot needs View Channels and Manage Channels on the category if it has its own permission overrides.     |
| The admin channel → Copy Channel ID | `ADMIN_CHANNEL_ID`            | A private channel for creating projects. Create one if needed.                                                                                          |
| Your own name → Copy User ID        | `ADMIN_USER_IDS`              | Comma-separated. Only these people can use the admin channel. Empty means nobody.                                                                       |

Two behaviour switches, both on by default:

- `DISCORD_REQUIRE_MENTION=true`: in project channels, the bot only answers top-level messages that @mention it. Messages inside ticket threads and the admin channel don't need a mention. Set `false` to answer every message.
- `DISCORD_PROJECT_CHANNEL_AUTO_CREATE=true`: creating a project also creates its channel.

From [PR #50](https://github.com/joel611/project-os/pull/50) (not merged yet): the bot only works in server channels. It ignores DMs, and every slash command, `/connect` included, is unavailable in DMs. It also adds one optional setting:

- `DISCORD_MEMBER_ROLE_IDS`: comma-separated role ids (right-click a role → Copy Role ID). When set, only people holding one of those roles can trigger the bot. Others' messages are ignored silently, and their slash commands get a private refusal. People in `ADMIN_USER_IDS` always pass, whatever roles they hold. Unset means everyone can use the bot.

### 1.4 Check it

Start the stack (see [7. Run it](#7-run-it)), then:

1. The adapter logs `registered slash commands in guild <id>`.
2. In the admin channel, run `/project-create name:Demo`. A new `#demo` channel appears.
3. In that channel, post `@YourBot hello`. The bot replies. A request that becomes a ticket opens a thread on your message.

---

## 2. Google Drive (OAuth client)

This lets each person run `/connect provider:Google` and link their own Google account. The Coordinator asks Google for these scopes (`packages/auth/src/connections.ts`):

| Scope                                            | Why                                                           |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `openid`, `email`, `profile`                     | Show who linked the account                                   |
| `https://www.googleapis.com/auth/drive.readonly` | Read Drive files the person can already see. No write access. |

It also asks for offline access with a consent prompt, so it gets a refresh token and Workers keep access after the first hour.

### 2.1 Create a Google Cloud project and enable Drive

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick one).
2. Go to **APIs & Services → Library**, search **Google Drive API**, and click **Enable**.

### 2.2 Configure the consent screen

Go to **Google Auth Platform** (APIs & Services → OAuth consent screen):

1. **Branding**: set the app name and a support email.
2. **Audience**:
   - If everyone who will link an account is in one Google Workspace, choose **Internal**. No test user list, and refresh tokens don't expire after 7 days.
   - Otherwise choose **External** and leave it in **Testing**. Under **Test users**, add the Google email of every person who will link an account (up to 100). Anyone not on the list gets "access blocked".
3. **Data access**: click **Add or remove scopes** and add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and `.../auth/drive.readonly`. Save.

`drive.readonly` is a restricted scope. Publishing an External app to Production needs Google's verification and a security assessment, so this project stays in Testing for now. In Testing, **refresh tokens expire after 7 days**, so people need to run `/connect` again about once a week. When a token stops working, the Worker sets the ticket to blocked and the bot asks the person to reconnect.

### 2.3 Create the OAuth client

1. Go to **Clients → Create client** (APIs & Services → Credentials → Create credentials → OAuth client ID).
2. **Application type**: **Web application**.
3. **Authorized redirect URIs**: add `<PUBLIC_URL>/api/auth/callback/google`. Locally that is:
   ```text
   http://localhost:8080/api/auth/callback/google
   ```
   No JavaScript origins are needed.
4. Click **Create** and copy the values into `.env`:
   ```sh
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

---

## 3. GitHub App

GitHub uses a **GitHub App**, not an OAuth App. A GitHub App's user tokens are limited to the repos the app is installed on, intersected with what the person can access, and they expire after 8 hours and refresh. GitHub Apps ignore OAuth scopes: what the token can do is set by the app's permissions below.

### 3.1 Create the app

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

### 3.2 Get the client credentials

On the app's **General** page:

1. Copy the **Client ID** (starts with `Iv`). It is not the App ID.
2. Under **Client secrets**, click **Generate a new client secret** and copy it.

```sh
GITHUB_CLIENT_ID=Iv...
GITHUB_CLIENT_SECRET=...
```

You don't need the app's private key. project-os only uses user tokens.

### 3.3 Install the app on your repos

On the app page, click **Install App**, choose the account or organization that owns the repos, and select **Only select repositories** (or all). A person's token only reaches repos this installation covers. Install it on each account or org whose repos Workers should see.

---

## 4. Turn on account linking

Account linking stays off until `BETTER_AUTH_SECRET` and at least one of the Google or GitHub clients are set. The Coordinator logs `account linking off: ...` while it is off.

```sh
# Signs cookies and encrypts stored OAuth tokens. Keep it stable: changing it
# makes every linked account unreadable, and people have to /connect again.
BETTER_AUTH_SECRET=$(openssl rand -base64 32)

# Where browsers reach the Coordinator. Used for connect links and OAuth callbacks,
# and must match the redirect / callback URLs you registered in steps 2 and 3.
PUBLIC_URL=http://localhost:8080
```

`http://localhost:8080` only works for people opening the link on the machine running the Coordinator. For teammates on other machines, expose the Coordinator on an HTTPS URL (a tunnel such as `cloudflared` or `ngrok`, or a real deploy), set `PUBLIC_URL` to it, and update the Google redirect URI and the GitHub callback URL to match. Google only allows `http://` redirect URIs for `localhost`.

How a person links an account:

1. Run `/connect provider:Google` (or GitHub) in any server channel the bot can see. The reply is private.
2. Open the one-time link (it works once, for 10 minutes) and approve on Google or GitHub.
3. The browser lands on "account connected". `/connections` shows what's linked, and `/disconnect` unlinks.

---

## 5. Personal workers

A developer can use their own computer as their Worker. It works only on the tickets they start; anyone without one, and they too while it's offline, gets the shared Worker.

Coordinator `.env`:

```sh
# Where people's computers reach the Coordinator (the Watcher registers and polls here).
# Same value as step 4; must be reachable from their machines, so a tunnel or public host.
PUBLIC_URL=https://coordinator.example.com

# The shared Worker for everyone else is a sandbox from the pool (step 6) when you set one up,
# else the shared Watcher (WORKER_ID). DEFAULT_WORKER_TYPE is used only when the classifier
# doesn't pick a worker type.
DEFAULT_WORKER_TYPE=

# Optional: how people install the Watcher. Default: bun install -g @project-os/watcher
# The package isn't on npm yet, so until it is, point this at something that installs it.
WATCHER_INSTALL_COMMAND=
```

Then, for each person:

1. Run `/register-worker` in any server channel (optionally `name:my-laptop`). The reply is private.
2. Paste the command it shows on the computer that should do the work. It needs Bun and the `claude` CLI signed in. The code works once, for 10 minutes.
3. The Watcher saves its credentials in `~/.config/project-os/watcher.json` and keeps running. Start it again later with `project-os-watcher`.
4. `/workers` lists your computers and whether they're online. `/unregister-worker worker:<name>` removes one.

A computer counts as online if it checked in within `HEALTH_WORKER_STALE_MIN` (15 minutes by default; it checks in every 5).

---

## 6. Cloud sandbox workers

Tickets that don't go to someone's own computer can run in a cloud sandbox: the Coordinator starts a fresh sandbox per ticket, runs a Pi session in it under its own worker id (`daytona-<ticketId>`, `cloudflare-<ticketId>` or `boat-<ticketId>`), and deletes the sandbox when the session ends. The host Watcher never sees these tickets.

You choose the providers. Each one joins the **pool** when its credentials are set, and `WORKER_PROVIDERS` sets which ones and in what order:

```sh
# Try Cloudflare first, then Daytona, then boat.dev. Unset: every configured provider,
# in the order daytona, cloudflare, boat.
WORKER_PROVIDERS=cloudflare,daytona,boat

# Required with any provider: the Coordinator's /mcp as the sandbox's cloud sees it
# (a tunnel such as https://abc.trycloudflare.com/mcp, never localhost).
SANDBOX_MCP_URL=https://coordinator.example.com/mcp
# Optional: Pi model (default openrouter/$CHAT_MODEL_ID) and session limit (default 1800 s).
SANDBOX_PI_MODEL=
SANDBOX_SESSION_TIMEOUT_SECONDS=
```

When the Coordinator assigns a ticket, it reads the pool and starts the first provider with room. Room means fewer active tickets on it than its `*_MAX_CONCURRENT` (no cap if unset). If every provider is full, or the pool is empty, the ticket goes to the shared Watcher (`WORKER_ID`). The classifier only decides "sandbox or not"; which sandbox is always the pool's call. Naming a provider that isn't configured stops the Coordinator at startup so a typo can't silently send everything to the Watcher.

| Provider           | Worker type     | Status    | Settings                                                                                           |
| ------------------ | --------------- | --------- | -------------------------------------------------------------------------------------------------- |
| Daytona            | `daytona_pi`    | Supported | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL`, `DAYTONA_SNAPSHOT`, `DAYTONA_MAX_CONCURRENT`        |
| Cloudflare Sandbox | `cloudflare_pi` | Supported | `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_TOKEN`, optional `CLOUDFLARE_SANDBOX_MAX_CONCURRENT` |
| boat.dev           | `boat_pi`       | Supported | `BOAT_API_KEY`, optional `BOAT_API_URL`, `BOAT_SANDBOX_SIZE`, `BOAT_MAX_CONCURRENT`                |

The older `DAYTONA_MCP_URL`, `DAYTONA_PI_MODEL` and `DAYTONA_SESSION_TIMEOUT_SECONDS` still work as fallbacks for the `SANDBOX_*` names.

### Daytona

1. Create an API key at [app.daytona.io](https://app.daytona.io) and set `DAYTONA_API_KEY`.
2. Optional: `DAYTONA_SNAPSHOT` for a snapshot with Node 22.19 or newer (Pi installs itself at session start).

### boat.dev

1. Create an API key (`boat api-key create project-os --preset ci`, or in the dashboard) and set `BOAT_API_KEY` (keys start with `boat_`).
2. Optional: `BOAT_SANDBOX_SIZE` (`small`, `default`, `large`, `xlarge`; `xlarge` needs a $100 plan or higher) and `BOAT_MAX_CONCURRENT`. Set the cap at or below your plan's sandboxes-at-once limit (100 on the $20 plan), so the pool moves on instead of failing.
3. Each ticket gets its own sandbox, created with the session's settings as sandbox env vars and deleted when the session ends. The TTL is the session limit plus 5 minutes, which reclaims it even if the Coordinator stops first. Sandboxes bill per second while they run.

### Cloudflare Sandbox

Cloudflare Sandboxes are Durable Objects backed by Containers, reachable only from a Worker binding. So you deploy a small bridge Worker (`apps/cloudflare-sandbox`) and the Coordinator talks to it over HTTPS with a shared token.

1. Use a Cloudflare account on the Workers Paid plan (Containers need it), and have Docker running locally (the deploy builds the sandbox image).
2. Deploy the bridge and give it a token:

   ```sh
   bun run --cwd apps/cloudflare-sandbox deploy
   openssl rand -hex 32   # the token
   bunx wrangler@4.153.0 secret put BRIDGE_TOKEN --cwd apps/cloudflare-sandbox
   ```

3. In the Coordinator `.env`, set `CLOUDFLARE_SANDBOX_URL` to the Worker's URL (`https://project-os-sandbox.<subdomain>.workers.dev`) and `CLOUDFLARE_SANDBOX_TOKEN` to the same token.
4. Optional: raise `containers[0].max_instances` in `apps/cloudflare-sandbox/wrangler.jsonc` and set `CLOUDFLARE_SANDBOX_MAX_CONCURRENT` to match, so the pool moves on to the next provider instead of waiting for a container.

The sandbox image is Cloudflare's base image (`docker.io/cloudflare/sandbox`, with Node and npm). A sandbox goes to sleep after 10 idle minutes, so one is reclaimed even if the Coordinator stops before deleting it.

---

## 7. Run it

```sh
docker compose up --build            # Coordinator :8080 (with the Discord bot), Grafana :3000

# Shared Watcher, on the host (only if you don't use sandbox or personal workers).
# It needs the `claude` CLI installed and signed in.
set -a; . ./.env; set +a
bun apps/watcher/src/main.bun.ts

# Or register this computer as your personal worker (code from /register-worker):
bun apps/watcher/src/main.bun.ts register <code> --server http://localhost:8080
```

Also set `OPENROUTER_API_KEY` and `CHAT_MODEL_ID` in `.env`; the Coordinator refuses to start without a model (Compose defaults `CHAT_MODEL_ID` to `anthropic/claude-sonnet-4.5`). SQLite and agent state live in the `coordinator-data` volume (`/data`). The Watcher launches `claude -p` with `--allowedTools "mcp__project-os__*"`, so headless sessions can call the Coordinator's MCP tools. See the README for running without Docker and for the dashboard.

The dashboard is read-only and expects the Coordinator on `:8080` (override with `COORDINATOR_URL`). `bun run --cwd apps/web build` exports it as a static site.

## 8. Cloudflare

Deploying to Cloudflare with Alchemy is covered in [docs/deployment.md](docs/deployment.md). The same values become Worker vars and secrets (`OPENROUTER_API_KEY`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` as secrets), and `PUBLIC_URL` plus the Google and GitHub callback URLs must point at the deployed Coordinator. Discord keeps running as its own process there, because a Worker can't hold a gateway WebSocket (`bun run --cwd apps/discord-gateway start`, see `docs/deployment.md`).

## Troubleshooting

| Symptom                                                     | Likely cause                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot is online but never answers                             | Message Content Intent is off, or the message didn't @mention the bot (`DISCORD_REQUIRE_MENTION`), or the channel isn't linked to a project |
| Bot ignores one person, or their slash commands are refused | `DISCORD_MEMBER_ROLE_IDS` is set and they don't hold one of those roles                                                                     |
| Slash commands don't show up                                | Invite missed `applications.commands`, or `DISCORD_GUILD_ID` is unset and global registration hasn't propagated yet (up to an hour)         |
| `/project-create` says it failed to create the channel      | Bot lacks Manage Channels, or `DISCORD_GUILD_ID` is wrong, or the category denies the bot                                                   |
| Tickets don't get threads                                   | Bot lacks Create Public Threads, Send Messages in Threads, or Read Message History in that channel                                          |
| `/connect` says linking is off                              | `BETTER_AUTH_SECRET` or the provider's client id/secret is missing from the Coordinator's environment                                       |
| `/register-worker` code says "expired, or already used"     | Codes work once, for 10 minutes. Run `/register-worker` again                                                                               |
| Your tickets still go to a sandbox after registering        | The Watcher isn't running or can't reach `PUBLIC_URL`. `/workers` shows whether it's online                                                 |
| Sandbox tickets stay `assigned` and nothing claims them     | `SANDBOX_MCP_URL` isn't reachable from the provider's cloud (it must be public). The Coordinator logs `<provider>: <worker> failed: …`      |
| Coordinator exits with `WORKER_PROVIDERS names "…"`         | That provider's credentials aren't set (e.g. `CLOUDFLARE_SANDBOX_URL`)                                                                      |
| Cloudflare sandbox calls fail with 401                      | `CLOUDFLARE_SANDBOX_TOKEN` doesn't match the bridge's `BRIDGE_TOKEN` secret                                                                 |
| Watcher gets HTTP 401 from `/mcp`                           | The computer was removed with `/unregister-worker`. Register it again                                                                       |
| Google says `redirect_uri_mismatch`                         | The redirect URI in Google doesn't exactly equal `<PUBLIC_URL>/api/auth/callback/google`                                                    |
| Google says "access blocked"                                | The person isn't a test user on an External app in Testing                                                                                  |
| GitHub says the redirect URI isn't associated               | The GitHub App's callback URL doesn't match `<PUBLIC_URL>/api/auth/callback/github`                                                         |
| Worker can't see a repo                                     | The GitHub App isn't installed on that repo, or the person who asked has no access to it                                                    |
| Google stops working after a week                           | Testing-mode refresh tokens expire after 7 days; run `/connect provider:Google` again                                                       |
