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

To create the bot and invite it to your server, follow [Discord bot setup](../guide/setup.md#_1-discord-bot).
