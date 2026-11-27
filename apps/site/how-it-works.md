# How it works

Your team's project knowledge is spread across chat, documents, code, and people's heads, so the same questions keep interrupting engineers. project-os lets anyone ask in the project's channel and get a grounded answer back. For the story behind it, see [Why project-os](why.md). For the design in depth, see the [technical architecture](reference/architecture.md).

![How project-os works: Discord and email brokers feed Project OS, whose ticket system sends work to a cloud sandbox; a local PC can run Claude, Codex, or pi.](how-it-works.svg)

| Part              | What it does                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| **Brokers**       | Bring in messages. Discord is where your team asks. Email is read only, to add facts to Project Memory.     |
| **Classifier**    | Works out what each message is about.                                                                       |
| **Pi Durable**    | Runs the Project OS agent.                                                                                  |
| **Project Memory** | Keeps the facts and decisions of each project.                                                             |
| **Ticket system** | Tracks each piece of work from question to answer.                                                          |
| **Workers**       | Do the research, in a cloud serverless sandbox or on a local PC with Claude, Codex, or pi.                  |

See [inbound channels](channels/index.md) for how messages get in, and [connectors](connectors/index.md) for what project-os can reach.

## How project memory is built

::: info Target design
This section describes where Project OS is heading, and some of it is not built yet. See [Limitations](security.md#limitations) for how it works today.
:::

Project OS puts an agent in each project's channel. Besides answering questions, it collects messages from the channel and from email, and digests them into **memory points**.

Each memory point is a **single sentence** that keeps its **root message**, so every memory has a source you can check. When someone asks "why do we do it this way?", the answer is grounded in what was actually said.

| Source      | What is read                                                                  | Root message                                                |
| ----------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Discord** | The project's channel and its ticket threads, with or without a mention.      | A link to the message, with who said it, when, and a quote. |
| **Email**   | Only mailboxes whose owners turned it on: the whole inbox or one Gmail label. | A Gmail link that the mailbox owner can open in Gmail.      |

Sensitive data is redacted before anything is sent to an AI model.

The agent keeps each person's own permissions. If someone asks about sensitive information in the project channel, the agent does not repeat it there. It points to the original email instead, and only people who already have that email can open it. See [Security](security.md).

## What a question goes through

1. Someone asks a question in the project's Discord channel.
2. The classifier works out what they need. If it is not sure, project-os asks them to clarify. A question about the progress of an existing ticket can be answered right away.
3. For new work, Project OS opens a ticket with the project's context.
4. A cloud sandbox or a local PC takes the ticket, does the research, and writes back what it found.
5. Project OS posts the answer in the channel.

What the worker learns can be saved to the project's memory, so the next related question starts with more context.
