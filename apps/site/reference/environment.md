# Environment variables

Every variable the apps read, in one place. Unset and empty mean the same thing. On Cloudflare the same names become Worker vars and secrets (see [Deploy to Cloudflare](../guide/deployment.md)).

## Application

The Coordinator's own settings. Each feature below has its own table.

| Variable                    | Required | Default                   | Description                                                                                                                                                                 |
| --------------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COORDINATOR_SERVICE_TOKEN` | Yes      |                           | Shared secret Channel Adapters send on `/inbound`, `/commands` and `/prompts/answer`. The Coordinator refuses to start without it. `openssl rand -base64 32`                |
| `BETTER_AUTH_SECRET`        | Yes      |                           | Signs dashboard sessions and encrypts stored OAuth tokens. The Coordinator refuses to start without it. Changing it signs everyone out and makes linked accounts unreadable |
| `ADMIN_EMAIL`               | Yes\*    |                           | The dashboard operator, created on first start. \*Without it and `ADMIN_PASSWORD`, nobody can sign in (sign-up is off)                                                      |
| `ADMIN_PASSWORD`            | Yes\*    |                           | The operator's password, at least 8 characters. Never overwritten once the operator exists                                                                                  |
| `ADMIN_EMAILS`              | No       |                           | More emails allowed into the dashboard, comma-separated. They sign in with Google                                                                                           |
| `PORT`                      | No       | `8080`                    | Port the Coordinator listens on (host runs)                                                                                                                                 |
| `PUBLIC_URL`                | No       | `http://localhost:$PORT`  | Where browsers and registered workers reach the Coordinator. Used for connect links, OAuth callbacks and attachment links                                                   |
| `WEB_ORIGIN`                | No       |                           | Origins allowed to call the API (CORS), comma-separated. The first is where Google sign-in returns to. `alchemy deploy` sets it to the dashboard URL                        |
| `DATABASE_PATH`             | No       | `.data/project-os.sqlite` | SQLite file (host runs). Relative paths resolve against the repo root. `DB_PATH` is read as a fallback                                                                      |
| `PI_STORAGE_PATH`           | No       | `.data/pi-durable.sqlite` | Pi Durable agent state (host runs)                                                                                                                                          |
| `ASSET_DIR`                 | No       | `.data/assets`            | Where Discord attachments are copied at intake and served from by signed links (host runs; Cloudflare uses the `ASSETS` R2 bucket)                                          |
| `SEED_PROJECT_NAME`         | No       | `Demo Project`            | Project created by `bun run seed`                                                                                                                                           |
| `SEED_DISCORD_CHANNEL_ID`   | No       |                           | Discord channel the seeded project is linked to                                                                                                                             |

## Models and agent runtime

See [Models](../guide/setup.md#models).

| Variable                      | Required | Default                        | Description                                                                                                                        |
| ----------------------------- | -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`          | Yes\*    |                                | \*Needed for any `openrouter/...` model, which the defaults are. Sandbox sessions reuse it                                         |
| `DEFAULT_MODEL`               | Yes      |                                | One `provider/model` string, e.g. `openrouter/anthropic/claude-sonnet-4.5`. The chat model, and the fallback for every model below |
| `DECISION_MODEL`              | No       | `openrouter/typesafe/jev-1.14` | The classifier that reads each message. Never falls back to `DEFAULT_MODEL`                                                        |
| `INTENT_CONFIDENCE_THRESHOLD` | No       | `0.5`                          | Classifier confidence below this is treated as unsure                                                                              |

Renamed, and the Coordinator stops if one is still set: `CHAT_MODEL_ID` and `CHAT_MODEL_PROVIDER` (now `DEFAULT_MODEL`), `CHANNEL_DIGEST_MODEL_ID` and `CHANNEL_DIGEST_MODEL_PROVIDER` (now `CHANNEL_DIGEST_MODEL`), `JEV_MODEL_ID` (now `DECISION_MODEL`).

## Discord

See [Discord setup](../channels/discord.md#set-up). Read by the Discord bot, whether it runs inside the Coordinator or as `apps/discord-gateway`.

| Variable                              | Required | Default | Description                                                                                                      |
| ------------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                   | No       |         | Turns Discord on. Unset runs without Discord. Ignored by the Coordinator when `DISCORD_SPLIT_GATEWAY_URL` is set |
| `DISCORD_GUILD_ID`                    | No       |         | Server where project channels are created and slash commands registered (unset: global, up to an hour)           |
| `DISCORD_PROJECT_CATEGORY_ID`         | No       |         | Category new project channels go under                                                                           |
| `DISCORD_PROJECT_CHANNEL_AUTO_CREATE` | No       | `true`  | Admin create project also creates its channel. `false` only links existing channels                              |
| `ADMIN_CHANNEL_ID`                    | No       |         | The admin channel, where `/project-create` and `/register-worker shared:True` work                               |
| `ADMIN_USER_IDS`                      | No       |         | Discord user ids allowed in the admin channel, comma-separated. Empty: nobody. They also pass the role gate      |
| `DISCORD_MEMBER_ROLE_IDS`             | No       |         | Only people holding one of these role ids can trigger the bot. Empty: everyone in the server                     |
| `DISCORD_REQUIRE_MENTION`             | No       | `true`  | Top-level project channel messages need an @mention. Threads and the admin channel never do                      |

### Separate Discord gateway

Only when Discord runs in its own process (a Cloudflare Coordinator, or a split self-host).

| Variable                     | Required | Default                 | Read by     | Description                                                                                                                                |
| ---------------------------- | -------- | ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_SPLIT_GATEWAY_URL`  | No       |                         | Coordinator | Where the Coordinator posts replies. Set, the Coordinator ignores `DISCORD_BOT_TOKEN`. On Cloudflare, set it to skip the gateway Container |
| `DISCORD_SPLIT_GATEWAY_PORT` | No       | `8081`                  | Gateway     | Port the gateway's `/reply` listens on                                                                                                     |
| `COORDINATOR_URL`            | No       | `http://localhost:8080` | Gateway     | Where the gateway forwards messages. It also sends `COORDINATOR_SERVICE_TOKEN` and reads `DISCORD_BOT_TOKEN`                               |

## Channel Digest

Turns project channel chatter into Project Memory. Whether a project is digested is a per-project dashboard setting; these are the timings for all projects.

| Variable                        | Required | Default         | Description                                                              |
| ------------------------------- | -------- | --------------- | ------------------------------------------------------------------------ |
| `CHANNEL_DIGEST_MODEL`          | No       | `DEFAULT_MODEL` | The digest's model, `provider/model`                                     |
| `CHANNEL_DIGEST_QUIET_MIN`      | No       | `30`            | Digest a project once its channel has been quiet this many minutes       |
| `CHANNEL_DIGEST_MAX_WAIT_MIN`   | No       | `360`           | ...or once its oldest waiting message is this old, even mid-conversation |
| `CHANNEL_DIGEST_RETENTION_DAYS` | No       | `7`             | Waiting raw messages older than this are dropped unread                  |
| `CHANNEL_DIGEST_MAX_MESSAGES`   | No       | `200`           | Most messages one digest reads; the rest wait for the next run           |
| `CHANNEL_DIGEST_RETRY_MIN`      | No       | `10`            | After a failed digest, wait this long before trying that project again   |

## Email Digest

Reads each person's Gmail inbox, read-only, into Project Memory. See [Email](../channels/email.md) for what it does and how to turn it on.

Each new email (with all mail chosen, promotions, social, spam and sent mail are skipped; with one label, only mail carrying it is read, whether it arrived with it or got it later) is redacted first: quoted replies are dropped, and secrets, one-time codes, card and phone numbers, link query strings and the address part of email addresses are masked. The classifier then matches it to a project. At 90% or more it is filed: the decisions and facts in it go to Project Memory, with the sender, subject and a redacted quote, and the email body is deleted. Below 90% it waits on the Email page for the person to pick a project (or dismiss it). Filing one by hand teaches the classifier: that sender and subject are shown as examples under the project from then on. Waiting emails are dropped after 30 days. It never sends, labels or changes mail.

| Variable       | Required | Default | Description                                                                          |
| -------------- | -------- | ------- | ------------------------------------------------------------------------------------ |
| `EMAIL_DIGEST` | No       | `false` | Let people turn on their own mailbox. Runs on the same per-minute tick as the health sweep |

The classifier is the `DECISION_MODEL`, and the summary uses the Channel Digest's model (`CHANNEL_DIGEST_MODEL`, else `DEFAULT_MODEL`).

## Sign-in and account linking

See [Google](../connectors/google.md#set-up), [GitHub](../connectors/github.md#set-up), [ClickUp](../connectors/clickup.md#set-up) and [account linking](../guide/setup.md#turn-on-account-linking). `/connect` for a provider is off until its client id and secret are both set. Callbacks are served at `PUBLIC_URL`.

| Variable                 | Required | Default | Description                                                                                                   |
| ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`       | No       |         | Google OAuth web client: Drive linking, and dashboard sign-in with Google                                     |
| `GOOGLE_CLIENT_SECRET`   | No       |         | Its secret                                                                                                    |
| `GOOGLE_ALLOWED_DOMAINS` | No       |         | Workspace domains, comma-separated. Set, anyone at them may sign in and every other Google account is refused |
| `GITHUB_CLIENT_ID`       | No       |         | GitHub App (not an OAuth App) client id                                                                       |
| `GITHUB_CLIENT_SECRET`   | No       |         | Its secret                                                                                                    |
| `CLICKUP_CLIENT_ID`      | No       |         | ClickUp app client id, for task attachments too big for Discord                                               |
| `CLICKUP_CLIENT_SECRET`  | No       |         | Its secret                                                                                                    |

## Health sweep and audit log

The sweep runs on a timer in host runs and on a per-minute Cron on Cloudflare.

| Variable                     | Required | Default | Description                                                        |
| ---------------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `HEALTH_SWEEP_EVERY_SEC`     | No       | `60`    | How often the sweep (and the Channel Digest) runs, host runs only  |
| `HEALTH_WORKER_STALE_MIN`    | No       | `15`    | A worker not seen for this long counts as offline                  |
| `HEALTH_UNPICKED_MIN`        | No       | `30`    | An `assigned` ticket nobody picked up for this long is flagged     |
| `HEALTH_FOLLOW_UP_MIN`       | No       | `15`    | An `in_progress` ticket quiet this long gets a "Status?" follow-up |
| `HEALTH_INACTIVITY_FAIL_MIN` | No       | `30`    | An `in_progress` ticket quiet this long is failed                  |
| `AUDIT_RETENTION_DAYS`       | No       | `90`    | Audit log entries older than this are deleted                      |
| `RUN_LOG_RETENTION_DAYS`     | No       | `30`    | Run transcripts older than this are deleted (their summaries stay) |

## Registered workers

See [Registered workers](../workers/local.md). Coordinator side.

| Variable                    | Required | Default                              | Description                                                         |
| --------------------------- | -------- | ------------------------------------ | ------------------------------------------------------------------- |
| `SHARED_WORKER_MAX_TICKETS` | No       | `1`                                  | Tickets one shared computer holds at once. Match its `MAX_SESSIONS` |
| `WATCHER_INSTALL_COMMAND`   | No       | `bun install -g @project-os/watcher` | Install command shown by `/register-worker`                         |

## Watcher

Read by `apps/watcher` on the computer that works tickets, from its shell.

| Variable                  | Required | Default                        | Description                                                                 |
| ------------------------- | -------- | ------------------------------ | --------------------------------------------------------------------------- |
| `PROJECT_OS_URL`          | No       |                                | Coordinator URL for `register` when `--server` isn't given                  |
| `WATCHER_AGENT`           | No       | saved choice, else first found | `claude`, `pi` or `codex`. Overrides the agent saved at `register`          |
| `WATCHER_MODEL`           | No       | the agent's own default        | Passed to the agent as `--model`. Overrides the saved model                 |
| `POLL_INTERVAL_MS`        | No       | `300000`                       | How often it polls for tickets                                              |
| `MAX_SESSIONS`            | No       | `1`                            | Agent sessions it runs at once                                              |
| `PROJECT_OS_WATCHER_HOME` | No       | `$XDG_CONFIG_HOME/project-os`  | Where its registration, workspaces and logs live (`XDG_CONFIG_HOME` defaults to `~/.config`) |

## Cloud sandbox pool

See [Cloud sandbox workers](../workers/cloud-sandbox.md). A provider joins the pool when its credentials are set.

| Variable                          | Required | Default                          | Description                                                                                                                         |
| --------------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_PROVIDERS`                | No       | every configured provider        | Providers in the order to try, comma-separated, from `daytona`, `cloudflare`, `boat`. Unset order: daytona, cloudflare, boat        |
| `SANDBOX_MCP_URL`                 | Yes\*    |                                  | \*With any provider. The Coordinator's `/mcp` as the sandbox's cloud sees it, never localhost. `DAYTONA_MCP_URL` still works        |
| `SANDBOX_PI_MODEL`                | No       | `DEFAULT_MODEL`                  | Pi's model in the sandbox, `provider/model`. `DAYTONA_PI_MODEL` still works                                                         |
| `SANDBOX_SESSION_TIMEOUT_SECONDS` | No       | `1800`                           | Longest a sandbox session runs. `DAYTONA_SESSION_TIMEOUT_SECONDS` still works                                                       |
| `SANDBOX_CREDENTIAL_PROXY`        | No       | `false`                          | `true`: sandboxes reach Google, GitHub and ClickUp through `/egress` and never hold the person's token ([proxy](../workers/cloud-sandbox.md#credential-proxy)) |
| `SANDBOX_EGRESS_URL`              | No       | `SANDBOX_MCP_URL` with `/egress` | The credential proxy as the sandbox's cloud sees it. Needed when `SANDBOX_MCP_URL` doesn't end in `/mcp`                            |

## Built-in skills over MCP (experimental)

Off unless `EXPERIMENTAL_MCP_SKILLS=true`. When on, the Coordinator's `/mcp` also serves the skills Project OS ships about itself: `project-os-tickets` (the claim, progress, ask, attach and finish loop), `project-os-memory` (what to read and what is worth saving) and `project-os-accounts` (`user_token` and the credential proxy). They are written in the repo and bundled with the Coordinator, so there is nothing to configure, store or sync, and every worker sees the same text. They are separate from the **Task types** skills above, which still install on the Worker before a ticket starts.

They are offered two ways, following the MCP [Skills extension](https://modelcontextprotocol.io/seps/2640-skills-extension) (SEP-2640):

- As resources: `skill://<name>/SKILL.md`, listed by `skills/list` and `skills/get` with a SHA-256 digest and size for each file, and read with `resources/read`.
- As tools: `skill_list` and `skill_read`, for agents that can't read MCP skill resources yet. The Worker prompt tells a Worker that has `skill_list` to read the skills before using the tools they cover.

This is experimental: the names, the URI layout and the flag can change, and no worker agent loads MCP skills natively yet, so the tools are the path that works today.

| Variable                  | Required | Default | Description                                                              |
| ------------------------- | -------- | ------- | ------------------------------------------------------------------------ |
| `EXPERIMENTAL_MCP_SKILLS` | No       | `false` | `true`: serve the built-in skills over `/mcp` (`skill_*` tools and `skill://` resources) |

## Skills

Build task types on the dashboard's **Task types** page. The Coordinator uses a connected shared GitHub account first, then `SKILLS_GITHUB_TOKEN`, then anonymous access. With multiple shared accounts, it uses the oldest account whose token it can retrieve or refresh. Account ID breaks ties. Personal accounts are not used. Anonymous access has a limit of 60 requests an hour.

| Variable             | Required | Default | Description                                                                                       |
| -------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `SKILLS_GITHUB_TOKEN` | No       |         | Fallback token when no shared GitHub credential is available. A token with no scopes reads public repos. Not sent to Workers |
| `WATCHER_SKILLS`     | No       | on      | On a Watcher computer, `0` stops it installing a ticket's task type before a session starts       |
| `WATCHER_RUN_LOG`    | No       | on      | On a Watcher computer, `0` (or `--no-run-log`) keeps session transcripts local instead of sending them to the Coordinator |
| `WATCHER_GIT_TIMEOUT_MS` | No   | `600000` | On a Watcher computer, how long a `git clone` or `git fetch` of a project repo may run before it is stopped |
| `WATCHER_PI_ACP`     | No       | off     | On a Watcher computer, `1` runs Pi through ACP (the Agent Client Protocol) instead of `pi --print`, which gives Pi a structured run log |
| `WATCHER_PI_ACP_COMMAND` | No   | `pi-acp` | Program the Watcher starts to speak ACP for Pi; the repo's `@project-os/pi-acp` package provides it |

### Daytona (paused)

| Variable                 | Required | Default                      | Description                                                  |
| ------------------------ | -------- | ---------------------------- | ------------------------------------------------------------ |
| `DAYTONA_API_KEY`        | Yes\*    |                              | \*To use Daytona. An API key from app.daytona.io             |
| `DAYTONA_API_URL`        | No       | `https://app.daytona.io/api` | API endpoint                                                 |
| `DAYTONA_SNAPSHOT`       | No       | Daytona's default snapshot   | Snapshot with Node 22.19 or later                            |
| `DAYTONA_MAX_CONCURRENT` | No       | no limit                     | Sandboxes at once before the pool moves to the next provider |

### boat.dev

| Variable              | Required | Default                   | Description                                          |
| --------------------- | -------- | ------------------------- | ---------------------------------------------------- |
| `BOAT_API_KEY`        | Yes\*    |                           | \*To use boat.dev. Starts with `boat_`               |
| `BOAT_API_URL`        | No       | `https://boat.dev/api/v1` | API endpoint                                         |
| `BOAT_SANDBOX_SIZE`   | No       | your account default      | `small`, `default`, `large` or `xlarge`              |
| `BOAT_MAX_CONCURRENT` | No       | no limit                  | Keep at or below your plan's sandboxes-at-once limit |

### Cloudflare Sandbox

| Variable                            | Required | Default  | Read by     | Description                                                                        |
| ----------------------------------- | -------- | -------- | ----------- | ---------------------------------------------------------------------------------- |
| `CLOUDFLARE_SANDBOX_URL`            | Yes\*    |          | Coordinator | \*To use Cloudflare Sandbox. URL of the bridge Worker in `apps/cloudflare-sandbox` |
| `CLOUDFLARE_SANDBOX_TOKEN`          | Yes\*    |          | Coordinator | \*With `CLOUDFLARE_SANDBOX_URL`. Same value as the bridge's `BRIDGE_TOKEN`         |
| `CLOUDFLARE_SANDBOX_MAX_CONCURRENT` | No       | no limit | Coordinator | Match the bridge's `containers.max_instances` (5 in its `wrangler.jsonc`)          |
| `BRIDGE_TOKEN`                      | Yes      |          | Bridge      | Wrangler secret on the bridge Worker (`wrangler secret put BRIDGE_TOKEN`)          |

## Telemetry

| Variable                             | Required | Default                  | Description                                                                |
| ------------------------------------ | -------- | ------------------------ | -------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | No       |                          | OTLP/HTTP endpoint for Pi Durable traces and metrics. Unset: telemetry off |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No       |                          | Traces-only endpoint; also turns telemetry on                              |
| `OTEL_SERVICE_NAME`                  | No       | `project-os-coordinator` | Service name on exported data. Other standard `OTEL_*` vars apply too      |

## Web dashboard

| Variable               | Required | Default                 | Description                                                                                                             |
| ---------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `COORDINATOR_URL`      | No       | `http://localhost:8080` | Where the Vite dev server proxies `/api`                                                                                |
| `VITE_COORDINATOR_URL` | No       |                         | Build time. The built dashboard calls this Coordinator directly instead of `/api`. The deploy sets it from `PUBLIC_URL` |

## Cloudflare deploy (Alchemy)

Read by `alchemy.run.ts` on top of the values above. See [Deploy to Cloudflare](../guide/deployment.md).

| Variable                   | Required | Default      | Description                                                                                 |
| -------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------- |
| `ALCHEMY_STAGE`            | No       | `live_$USER` | Stage to deploy when `--stage` isn't given                                                  |
| `ROOT_DOMAIN`              | No       |              | Serve each service at `<service>-<stage>-project-os.<ROOT_DOMAIN>`. Unset: workers.dev URLs |
| `CLOUDFLARE_ACCOUNT_ID`    | Yes\*    |              | \*In CI, instead of `alchemy profile` login                                                 |
| `CLOUDFLARE_API_TOKEN`     | Yes\*    |              | \*In CI, instead of `alchemy profile` login                                                 |
| `COORDINATOR_DEV_PORT`     | No       | `8787`       | `bun run dev:cf` port for the Coordinator                                                   |
| `DASHBOARD_DEV_PORT`       | No       | `8788`       | `bun run dev:cf` port for the dashboard                                                     |
| `DISCORD_GATEWAY_DEV_PORT` | No       | `8789`       | `bun run dev:cf` port for the Discord gateway                                               |
