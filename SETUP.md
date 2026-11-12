# Setup

How to connect project-os to Discord, Google Drive, and GitHub, step by step, with the exact permissions each one needs. For what the system does, see [`README.md`](README.md).

You need three things working, in this order:

| Step                                                 | What it gives you                                                                                          | Required?         | `.env` keys                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| [1. Discord bot](#1-discord-bot)                     | The bot hears messages, replies, creates project channels and ticket threads                               | Yes               | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PROJECT_CATEGORY_ID`, `ADMIN_CHANNEL_ID`, `ADMIN_USER_IDS` |
| [2. Google Drive](#2-google-drive-oauth-client)      | Each person links their own Google account, so Workers read Drive with that person's access                | Optional          | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                   |
| [3. GitHub](#3-github-app)                           | Each person links their own GitHub account, so Workers use `gh` / `git` with that person's access          | Optional          | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                                                   |
| [4. Account linking](#4-turn-on-account-linking)     | Turns on `/connect` for steps 2 and 3                                                                      | If you did 2 or 3 | `PUBLIC_URL`                                                                                                 |
| [5. Registered workers](#5-registered-workers)       | People run `/register-worker` to use their own computer; admins add shared computers for everyone          | Optional          | `PUBLIC_URL`, `SHARED_WORKER_MAX_TICKETS`, `WATCHER_INSTALL_COMMAND`                                         |
| [6. Cloud sandbox workers](#6-cloud-sandbox-workers) | The Coordinator runs each shared ticket in a Daytona, Cloudflare or boat.dev sandbox, from a pool you pick | Optional          | `WORKER_PROVIDERS`, `SANDBOX_MCP_URL`, `DAYTONA_API_KEY`, `CLOUDFLARE_SANDBOX_URL`, `BOAT_API_KEY`           |

Start with:

```sh
bun install
cp .env.example .env
```

Every value below goes into `.env`. Docker Compose reads it for the Coordinator, which runs the Discord bot in the same process, and the Watcher reads it from your shell.

The Coordinator refuses to start without two secrets, and the dashboard needs someone to sign in as. Set these first:

```sh
# Signs dashboard sessions and encrypts stored OAuth tokens. Keep it stable: changing it
# signs everyone out and makes every linked account unreadable.
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
# What Channel Adapters (the Discord bot) call /inbound, /commands and /prompts/answer with.
# apps/discord-gateway needs the same value when it runs on its own.
COORDINATOR_SERVICE_TOKEN=$(openssl rand -base64 32)
# The dashboard operator, created on first start. Sign-up is off: without these, nobody can
# sign in. The password needs at least 8 characters.
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=...
# Optional: more emails allowed into the dashboard, comma-separated. They sign in with Google.
# ADMIN_EMAILS=teammate@example.com
# Optional: instead of listing people, let anyone at your Google Workspace domain(s) in.
# GOOGLE_ALLOWED_DOMAINS=acme.com
```

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

| Scope                   | Why                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot`                   | Adds the bot user to the server                                                                                                                         |
| `applications.commands` | Lets the bot register `/project-create`, `/connect`, `/disconnect`, `/connections`, `/register-worker`, `/workers`, `/unregister-worker`, `/source-add` |

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
- Channel digest: the Coordinator also keeps the messages it doesn't answer, in linked project channels and their ticket threads, and saves the decisions and facts in them to Project Memory once a conversation has been quiet for 30 minutes (`CHANNEL_DIGEST_QUIET_MIN`). Each entry keeps the messages it came from (who, when, a quote and a link). Raw messages are deleted once digested, or after 7 days. Turn it off, or have it post what it saved, per project in the dashboard under Settings → General.
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
3. **Authorized redirect URIs**: add `<PUBLIC_URL>/api/auth/callback/google` for account linking, and `<PUBLIC_URL>/api/auth/callback/google-signin` for signing in to the dashboard with Google. Locally that is:
   ```text
   http://localhost:8080/api/auth/callback/google
   http://localhost:8080/api/auth/callback/google-signin
   ```
   No JavaScript origins are needed.
4. Click **Create** and copy the values into `.env`:
   ```sh
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

The same client also adds **Continue with Google** to the dashboard's sign-in page once `WEB_ORIGIN` is set to where the dashboard is served (`http://localhost:5173` for `bun run --cwd apps/web dev`). Google returns there after sign-in. Only `ADMIN_EMAIL` and the emails in `ADMIN_EMAILS` get in, and only when Google has verified the address. A Google account with the same address as the `ADMIN_EMAIL` operator signs in as that operator, so the password and Google both work.

To let your whole team in without listing everyone, set `GOOGLE_ALLOWED_DOMAINS` to your Google Workspace domain (comma-separate several):

```sh
GOOGLE_ALLOWED_DOMAINS=acme.com
```

Once it's set, Google sign-in takes only accounts of those domains, and anyone at them gets in. The Coordinator checks Google's `hd` (hosted domain) claim as well as the email, so a personal Google account registered with an `@acme.com` address is refused. Emails in `ADMIN_EMAILS` outside those domains are refused too. The `ADMIN_EMAIL` operator can always sign in with the password. With one domain, Google's account chooser also shows only that domain's accounts. Linking Google Drive with `/connect` isn't affected.

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

## 3b. ClickUp app (optional)

Discord caps an upload at 25 MB, so a PM sends a big video through ClickUp: they attach it to a ClickUp task, paste the task link in Discord, and the Worker downloads it with that PM's own ClickUp token (read access follows their workspace permissions). Images and other small files go straight in Discord and need no ClickUp.

1. In ClickUp, open the avatar menu → **Settings → Apps → Create new app**.
2. Set the **Redirect URL** to `<PUBLIC_URL>/api/auth/callback/clickup`, e.g. `http://localhost:8080/api/auth/callback/clickup`.
3. Copy the **Client ID** and **Client Secret**:

   ```sh
   CLICKUP_CLIENT_ID=...
   CLICKUP_CLIENT_SECRET=...
   ```

People link it with `/connect provider:ClickUp`. During authorization ClickUp asks them to pick the workspace(s) the app can reach. ClickUp has no scopes.

---

## 4. Turn on account linking

Account linking stays off until at least one of the Google, GitHub or ClickUp clients is set, besides the `BETTER_AUTH_SECRET` every Coordinator needs. The Coordinator logs `account linking off: ...` while it is off.

```sh
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

## 5. Registered workers

Computers running the Watcher take tickets after they register with a one-time code. There are two kinds:

- **Personal:** a developer's own computer. It works only on the tickets they start.
- **Shared:** a computer an admin adds to the pool. It works on anyone's tickets.

A new ticket goes to the requester's own computer if it's online, else to an online shared computer with room, else to a sandbox (step 6). If none of them has room, the ticket is **queued**: its thread says so, and the health sweep assigns it as soon as something frees up. Nothing runs tickets unless at least one of these is set up.

Coordinator `.env`:

```sh
# Where people's computers reach the Coordinator (the Watcher registers and polls here).
# Same value as step 4; must be reachable from their machines, so a tunnel or public host.
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
4. `/workers` lists your computers, and the shared ones, and whether they're online. `/unregister-worker worker:<name>` removes one of yours.
5. To take the Watcher off a computer, run `project-os-watcher uninstall` there (add `--yes` to skip the question). It stops running Watchers, removes the package, deletes `watcher.json` and `mcp.json` from `~/.config/project-os`, and drops the Coordinator from `~/.pi/agent/mcp.json`. Then run `/unregister-worker` so the Coordinator stops listing it.

For a shared computer, an admin (in `ADMIN_USER_IDS`) does the same in the admin channel with `shared:True`: `/register-worker shared:True name:build-box`, then pastes the command on that computer. `/workers shared:True` lists the shared computers and `/unregister-worker shared:True worker:<name>` removes one. Both kinds show in the dashboard sidebar under Workers.

**Try it in Docker.** `scripts/watcher-vm.sh up` starts the Coordinator and a `watcher-vm` container that stands in for an external VM, and seeds a demo project with tickets. `scripts/watcher-vm.sh register` runs `/register-worker` through `POST /commands` (no Discord) and runs the printed install script line inside the container. The package isn't on npm, so the image links the Watcher from the repo and the script's install step is set to `true`. The image has both `pi` and `codex`, so `register` asks for the agent through `/register-worker agent:`: `WATCHER_VM_AGENT` (default `pi`) and `WATCHER_VM_MODEL`. Pi uses `OPENROUTER_API_KEY` and `SANDBOX_PI_MODEL` (the default model for Pi). For Codex, `up` copies your host `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) into the container at start, so it is never baked into the image and goes away with the container; run `WATCHER_VM_AGENT=codex scripts/watcher-vm.sh register`. The VM reaches the Coordinator at `host.docker.internal:8080` (the script sets `PUBLIC_URL` to that). `scripts/watcher-vm.sh logs` follows the Watcher.

A computer counts as online if it checked in within `HEALTH_WORKER_STALE_MIN` (15 minutes by default; it checks in every 5).

---

## 6. Cloud sandbox workers

Tickets that no personal or shared computer takes (step 5) can run in a cloud sandbox: the Coordinator starts a fresh sandbox per ticket, runs a Pi session in it under its own worker id (`daytona-<ticketId>`, `cloudflare-<ticketId>` or `boat-<ticketId>`), and deletes the sandbox when the session ends. No Watcher ever sees these tickets.

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

When the Coordinator assigns a ticket, it reads the pool and starts the first provider with room. Room means fewer active tickets on it than its `*_MAX_CONCURRENT` (no cap if unset). If every provider is full, or the pool is empty, the ticket is queued until something has room. Which sandbox runs a ticket is always the pool's call. Worker ids are `<provider>-<id>`. Naming one that isn't configured, or an unknown name, stops the Coordinator at startup so a typo can't silently leave tickets queued.

| Provider           | `WORKER_PROVIDERS` name | Worker type     | Status    | Settings                                                                                           |
| ------------------ | ----------------------- | --------------- | --------- | -------------------------------------------------------------------------------------------------- |
| Daytona            | `daytona`               | `daytona_pi`    | Paused    | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL`, `DAYTONA_SNAPSHOT`, `DAYTONA_MAX_CONCURRENT`        |
| Cloudflare Sandbox | `cloudflare`            | `cloudflare_pi` | Supported | `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_TOKEN`, optional `CLOUDFLARE_SANDBOX_MAX_CONCURRENT` |
| boat.dev           | `boat`                  | `boat_pi`       | Supported | `BOAT_API_KEY`, optional `BOAT_API_URL`, `BOAT_SANDBOX_SIZE`, `BOAT_MAX_CONCURRENT`                |

The older `DAYTONA_MCP_URL`, `DAYTONA_PI_MODEL` and `DAYTONA_SESSION_TIMEOUT_SECONDS` still work as fallbacks for the `SANDBOX_*` names.

### Daytona

**Paused.** The code stays and works up to launching the sandbox, but a sandbox can only reach the Coordinator's public `/mcp` URL on Daytona's Tier 3, which is too costly for now. On a lower tier Pi installs and runs but never connects, and the ticket stays `assigned`. We are not investing further until that changes; use a registered device, Cloudflare Sandbox or boat.dev instead.

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

# A Watcher on this computer, if you want it to work tickets (it needs the `claude` CLI
# installed and signed in, or set WATCHER_AGENT=pi or codex for that CLI, and optionally
# WATCHER_MODEL). Register it first with the code from /register-worker (yours),
# or /register-worker shared:True in the admin channel (for everyone):
bun apps/watcher/src/main.bun.ts register <code> --server http://localhost:8080
# Later runs need no code:
bun apps/watcher/src/main.bun.ts
```

Also set `OPENROUTER_API_KEY` and `CHAT_MODEL_ID` in `.env`; the Coordinator refuses to start without a model (Compose defaults `CHAT_MODEL_ID` to `anthropic/claude-sonnet-4.5`). SQLite and agent state live in the `coordinator-data` volume (`/data`). By default the Watcher launches `claude -p` with `--allowedTools "mcp__project-os__*"`, so headless sessions can call the Coordinator's MCP tools. `WATCHER_AGENT=pi` runs `pi --print` and `WATCHER_AGENT=codex` runs `codex exec` instead, each with the Coordinator added as an MCP server. See the README for running without Docker and for the dashboard.

The dashboard expects the Coordinator on `:8080` (override with `COORDINATOR_URL`) and opens on a sign-in page. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, or with Google (step 2). `bun run --cwd apps/web build` exports it as a static site.

## 8. Cloudflare

Deploying to Cloudflare with Alchemy is covered in [docs/deployment.md](docs/deployment.md). The same values become Worker vars and secrets (`OPENROUTER_API_KEY`, `BETTER_AUTH_SECRET`, `COORDINATOR_SERVICE_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` as secrets). The deploy fails without `BETTER_AUTH_SECRET` and `COORDINATOR_SERVICE_TOKEN`, and the Discord gateway container gets the service token too. `PUBLIC_URL` plus the Google and GitHub callback URLs must point at the deployed Coordinator. Discord keeps running as its own process there, because a Worker can't hold a gateway WebSocket (`bun run --cwd apps/discord-gateway start`, see `docs/deployment.md`).

## Troubleshooting

| Symptom                                                      | Likely cause                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot is online but never answers                              | Message Content Intent is off, or the message didn't @mention the bot (`DISCORD_REQUIRE_MENTION`), or the channel isn't linked to a project       |
| Bot ignores one person, or their slash commands are refused  | `DISCORD_MEMBER_ROLE_IDS` is set and they don't hold one of those roles                                                                           |
| Slash commands don't show up                                 | Invite missed `applications.commands`, or `DISCORD_GUILD_ID` is unset and global registration hasn't propagated yet (up to an hour)               |
| `/project-create` says it failed to create the channel       | Bot lacks Manage Channels, or `DISCORD_GUILD_ID` is wrong, or the category denies the bot                                                         |
| Tickets don't get threads                                    | Bot lacks Create Public Threads, Send Messages in Threads, or Read Message History in that channel                                                |
| Coordinator exits with `... is required`                     | `BETTER_AUTH_SECRET` or `COORDINATOR_SERVICE_TOKEN` is unset or blank in the Coordinator's environment                                            |
| Discord messages reach nothing, gateway logs `responded 401` | `apps/discord-gateway` has no `COORDINATOR_SERVICE_TOKEN`, or a different one from the Coordinator's                                              |
| Dashboard sign-in says the email and password don't match    | `ADMIN_EMAIL` / `ADMIN_PASSWORD` were unset on the Coordinator's first start, or the password changed since. The seed never overwrites a password |
| Google sign-in says it didn't work for that account          | The email isn't `ADMIN_EMAIL` or in `ADMIN_EMAILS`, or Google hasn't verified it                                                                  |
| Google sign-in says it only takes `@domain` accounts         | `GOOGLE_ALLOWED_DOMAINS` is set and the account isn't a Workspace account of one of those domains                                                 |
| `/connect` says linking is off                               | The provider's client id/secret is missing from the Coordinator's environment                                                                     |
| `/register-worker` code says "expired, or already used"      | Codes work once, for 10 minutes. Run `/register-worker` again                                                                                     |
| Your tickets still go to a sandbox after registering         | The Watcher isn't running or can't reach `PUBLIC_URL`. `/workers` shows whether it's online                                                       |
| Tickets say they're queued and stay `open`                   | No personal or shared computer is online with room and no sandbox provider has room. Start a Watcher, or set up a provider (step 6)               |
| Watcher exits with "isn't registered yet"                    | It no longer runs unregistered. Run `/register-worker` (or `shared:True` as an admin) and paste the command                                       |
| Sandbox tickets stay `assigned` and nothing claims them      | `SANDBOX_MCP_URL` isn't reachable from the provider's cloud (it must be public). The Coordinator logs `sandbox-<provider>: <worker> failed: …`    |
| Coordinator exits with `WORKER_PROVIDERS names "…"`          | That provider's credentials aren't set (e.g. `CLOUDFLARE_SANDBOX_URL`)                                                                            |
| Cloudflare sandbox calls fail with 401                       | `CLOUDFLARE_SANDBOX_TOKEN` doesn't match the bridge's `BRIDGE_TOKEN` secret                                                                       |
| Watcher gets HTTP 401 from `/mcp`                            | The computer was removed with `/unregister-worker`. Register it again                                                                             |
| Google says `redirect_uri_mismatch`                          | The redirect URI in Google doesn't exactly equal `<PUBLIC_URL>/api/auth/callback/google`                                                          |
| Google says "access blocked"                                 | The person isn't a test user on an External app in Testing                                                                                        |
| GitHub says the redirect URI isn't associated                | The GitHub App's callback URL doesn't match `<PUBLIC_URL>/api/auth/callback/github`                                                               |
| Worker can't see a repo                                      | The GitHub App isn't installed on that repo, or the person who asked has no access to it                                                          |
| Google stops working after a week                            | Testing-mode refresh tokens expire after 7 days; run `/connect provider:Google` again                                                             |
