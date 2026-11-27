# Configuration

The settings every install shares. New here? Start with the [Quick start](quick-start.md). For what the system does, see [How it works](../how-it-works.md).

```sh
cp .env.example .env
```

Every value goes into `.env`. [Environment variables](../reference/environment.md) lists each one with its default. Docker Compose reads the file for the Coordinator, which runs the Discord bot in the same process, and the Watcher reads it from your shell.

## Required settings

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

## Parts to set up

Each part has its own setup steps:

| Set up                                           | What it gives you                                                           | Required?                   |
| ------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------- |
| [Discord bot](../channels/discord.md#set-up)     | The bot hears messages, replies, creates project channels and ticket threads | Yes                         |
| [Email](../channels/email.md#set-up)             | People can add their Gmail to Project Memory                                | Optional                    |
| [Google Drive](../connectors/google.md#set-up)   | Each person links their own Google account                                  | Optional                    |
| [GitHub](../connectors/github.md#set-up)         | Each person links their own GitHub account                                  | Optional                    |
| [ClickUp](../connectors/clickup.md#set-up)       | Workers download files attached to ClickUp tasks                            | Optional                    |
| [Account linking](#turn-on-account-linking)      | Turns on `/connect` for the connectors                                      | If you set up any connector |
| [Local computer](../workers/local.md)            | People use their own computer, or a shared one, as a worker                 | At least one worker type    |
| [Cloud sandbox](../workers/cloud-sandbox.md)     | Tickets run in a Cloudflare or boat.dev sandbox                             | At least one worker type    |

## Models

Each model is one `provider/model` string: the provider is everything before the first `/`, so `openrouter/anthropic/claude-sonnet-4.5` is `anthropic/claude-sonnet-4.5` on OpenRouter (`OPENROUTER_API_KEY`).

| Key                    | Used for                                                   | Unset                                                                                                                      |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_MODEL`        | The Coordinator's chat, and every model below that's unset | Required: the Coordinator refuses to start (Compose and Cloudflare default it to `openrouter/anthropic/claude-sonnet-4.5`) |
| `CHANNEL_DIGEST_MODEL` | The Channel Digest                                         | `DEFAULT_MODEL`                                                                                                            |
| `SANDBOX_PI_MODEL`     | Pi in [cloud sandbox workers](../workers/cloud-sandbox.md)                       | `DEFAULT_MODEL`                                                                                                            |
| `DECISION_MODEL`       | Classifying each message (a classifier model)              | `openrouter/typesafe/jev-1.14`, never `DEFAULT_MODEL`                                                                      |

The Coordinator also refuses to start when a model isn't one pi-ai knows, and when an old name is set: `CHAT_MODEL_ID` and `CHAT_MODEL_PROVIDER` became `DEFAULT_MODEL`, `CHANNEL_DIGEST_MODEL_ID` and `CHANNEL_DIGEST_MODEL_PROVIDER` became `CHANNEL_DIGEST_MODEL`, and `JEV_MODEL_ID` became `DECISION_MODEL`.

Workers call the `user_token` MCP tool, which returns the token of the person behind the ticket's latest message (or a shared account an admin assigned to a person who linked none), so Google's and GitHub's own permissions decide what a Worker can reach. Cloud sandbox workers can instead go through the credential proxy ([credential proxy](../workers/cloud-sandbox.md#credential-proxy)), so the token never reaches the sandbox or its model.

## Turn on account linking

Account linking stays off until at least one of the Google, GitHub or ClickUp clients is set, besides the `BETTER_AUTH_SECRET` every Coordinator needs. The Coordinator logs `account linking off: ...` while it is off.

```sh
# Where browsers reach the Coordinator. Used for connect links and OAuth callbacks,
# and must match the redirect / callback URLs you registered for each connector.
PUBLIC_URL=http://localhost:8080
```

`http://localhost:8080` only works for people opening the link on the machine running the Coordinator. For teammates on other machines, expose the Coordinator on an HTTPS URL (a tunnel such as `cloudflared` or `ngrok`, or a real deploy), set `PUBLIC_URL` to it, and update the Google redirect URI and the GitHub callback URL to match. Google only allows `http://` redirect URIs for `localhost`.

How a person links an account:

1. Run `/connect provider:Google` (or GitHub) in any server channel the bot can see. The reply is private.
2. Open the one-time link (it works once, for 10 minutes) and approve on Google or GitHub.
3. The browser lands on "account connected". `/connections` shows what's linked, and `/disconnect` unlinks.

## Dashboard sign-in

Dashboard sign-in with Google uses the [Google connector's OAuth client](../connectors/google.md#set-up).

That client adds **Continue with Google** to the dashboard's sign-in page once `WEB_ORIGIN` is set to where the dashboard is served (`http://localhost:5173` for `bun run --cwd apps/web dev`). Google returns there after sign-in. Only `ADMIN_EMAIL` and the emails in `ADMIN_EMAILS` get in, and only when Google has verified the address. A Google account with the same address as the `ADMIN_EMAIL` operator signs in as that operator, so the password and Google both work.

To let your whole team in without listing everyone, set `GOOGLE_ALLOWED_DOMAINS` to your Google Workspace domain (comma-separate several):

```sh
GOOGLE_ALLOWED_DOMAINS=acme.com
```

Once it's set, Google sign-in takes only accounts of those domains, and anyone at them gets in. The Coordinator checks Google's `hd` (hosted domain) claim as well as the email, so a personal Google account registered with an `@acme.com` address is refused. Emails in `ADMIN_EMAILS` outside those domains are refused too. The `ADMIN_EMAIL` operator can always sign in with the password. With one domain, Google's account chooser also shows only that domain's accounts. Linking Google Drive with `/connect` isn't affected.

### Discord members on the dashboard

Anyone on Discord can also sign in to see **My tickets**: the tickets they asked for or wrote in (in the channel, the ticket's thread, or by answering its prompts). Nothing else of the dashboard is theirs. They run `/dashboard` in Discord, open the Google link it gives them (the same one-time link as `/connect provider:Google`), and then choose **Continue with Google** on the dashboard with that same Google account. The Coordinator matches the Google account id, not the email, to the Discord user who linked it. This works outside `ADMIN_EMAILS` and `GOOGLE_ALLOWED_DOMAINS`, since `DISCORD_MEMBER_ROLE_IDS` already decides who may use the bot. `/disconnect provider:Google` ends their dashboard access too. Operators whose Google account is linked the same way also get **My tickets** next to everything else. `/dashboard` needs `WEB_ORIGIN` set.

### Dashboard roles

Every dashboard user has a role. **Admin** can do everything. **Member** can read only the tickets they are involved in, the same view as **My tickets** below. A new Google sign-in (from `ADMIN_EMAILS` or `GOOGLE_ALLOWED_DOMAINS`) starts as a member, so the first thing to do is sign in with the `ADMIN_EMAIL` password, open **Members**, and promote the people who should manage the dashboard. The `ADMIN_EMAIL` operator is always an admin, and the last admin can't be demoted. Nothing needs configuring: roles live in the database, and a migration makes everyone who could already sign in an admin.

Permissions are a resource and an action, for example `source:delete` or `ticket:update`. The table is `ROLE_GRANTS` in `packages/contracts/src/permissions.ts`; the Coordinator enforces it on each route and the dashboard hides what a role can't use.
