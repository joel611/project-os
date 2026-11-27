# Discord

Discord is where your team asks questions and gets answers. Each project is linked to its Discord channel.

## Ask a question

1. Mention the bot in the project's channel. It reacts with 👀 when it accepts your message.
2. When your request becomes a ticket, the bot opens a thread on your message.
3. The answer arrives in that thread. Reply there to follow up. No mention is needed.

If the work needs more information from you, answer in the thread and the work continues.

## Useful commands

| Command            | What it does                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `/project-create`  | Creates a project and its channel. For admins, in the admin channel.                                              |
| `/source-add`      | Links a [GitHub](../connectors/github.md) repository or [Google](../connectors/google.md) Drive folder to a project. |
| `/connect`         | Links your own account for a [connector](../connectors/index.md).                                                 |
| `/dashboard`       | Opens the web dashboard to see your tickets.                                                                      |
| `/register-worker` | Sets up your computer as a local worker.                                                                          |

## Learning from conversations

project-os also reads the messages it does not answer in project channels and ticket threads. It saves the decisions and facts to Project Memory, with who said them, when, a quote, and a link. Raw messages are deleted once processed, or after 7 days.

This is on by default and posts nothing. You can turn it off for each project in the dashboard.

## Set up

For the person who runs project-os. Values go into `.env`.

### Create the application and bot

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

### Invite the bot to your server

The invite needs two **scopes**:

| Scope                   | Why                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot`                   | Adds the bot user to the server                                                                                                                                       |
| `applications.commands` | Lets the bot register `/project-create`, `/connect`, `/disconnect`, `/connections`, `/dashboard`, `/register-worker`, `/workers`, `/unregister-worker`, `/source-add` |

And these **bot permissions**:

| Permission               | Used for                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| View Channels            | See project channels and the admin channel                                                                            |
| Send Messages            | Post replies in channels                                                                                              |
| Read Message History     | Fetch the message a ticket thread is started from                                                                     |
| Manage Channels          | Create a channel for each new project (`/project-create`, admin `create project`)                                     |
| Create Public Threads    | Open a thread for each new ticket                                                                                     |
| Send Messages in Threads | Post ticket updates and the final answer inside that thread                                                           |
| Add Reactions            | React 👀 on a message the bot accepted |

Together these are permissions integer `309237714000`. Open this URL with your Application ID filled in, pick your server, and authorize:

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=309237714000
```

You can also build the same link in the portal under **OAuth2 → URL Generator** (or **Installation → Guild Install**) by ticking the scopes and permissions above.

If you'd rather not grant Manage Channels, set `DISCORD_PROJECT_CHANNEL_AUTO_CREATE=false` and link existing channels to projects instead. If threads are refused, tickets still work, the conversation just stays in the channel.

### Copy the ids into `.env`

Turn on **Developer Mode** in Discord (User Settings → Advanced → Developer Mode). Then right-click to **Copy ID**:

| Right-click                         | `.env` key                    | Notes                                                                                                                                                   |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server icon → Copy Server ID    | `DISCORD_GUILD_ID`            | Where project channels are created. Also makes slash commands appear immediately; without it they register globally and can take up to an hour to show. |
| A category → Copy Channel ID        | `DISCORD_PROJECT_CATEGORY_ID` | Optional. New project channels go under it. The bot needs View Channels and Manage Channels on the category if it has its own permission overrides.     |
| The admin channel → Copy Channel ID | `ADMIN_CHANNEL_ID`            | A private channel for creating projects. Create one if needed.                                                                                          |
| Your own name → Copy User ID        | `ADMIN_USER_IDS`              | Comma-separated. Only these people can use the admin channel. Empty means nobody.                                                                       |

Two behaviour switches, both on by default:

- `DISCORD_REQUIRE_MENTION=true`: in project channels, the bot only answers top-level messages that @mention it. Messages inside ticket threads and the admin channel don't need a mention. Set `false` to answer every message.
- Channel digest: on by default, see [Learning from conversations](#learning-from-conversations). Its timings are in [Environment](../guide/setup.md#channel-digest).
- `DISCORD_PROJECT_CHANNEL_AUTO_CREATE=true`: creating a project also creates its channel.

The bot only works in server channels. It ignores DMs, and every slash command, `/connect` included, is unavailable in DMs. One more setting is optional:

- `DISCORD_MEMBER_ROLE_IDS`: comma-separated role ids (right-click a role → Copy Role ID). When set, only people holding one of those roles can trigger the bot. Others' messages are ignored silently, and their slash commands get a private refusal. People in `ADMIN_USER_IDS` always pass, whatever roles they hold. Unset means everyone can use the bot.

### Check it

Start the stack (see [Run it](../guide/setup.md#run-it)), then:

1. The adapter logs `registered slash commands in guild <id>`.
2. In the admin channel, run `/project-create name:Demo`. A new `#demo` channel appears.
3. In that channel, post `@YourBot hello`. The bot replies. A request that becomes a ticket opens a thread on your message.
