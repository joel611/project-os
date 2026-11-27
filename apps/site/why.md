# Why project-os

## Background

A project's story rarely lives in one place. Conversations with the client sit in email. The team talks things over in its own chat. Tasks and issues are tracked in a ticket system. Each holds a piece of the picture, and nothing joins them together.

So people become the link. The longer a project runs, the more it depends on who remembers what. When that person is busy, away, or has moved on, answers are hard to find. Sometimes the reason behind a past decision can't be traced at all: everyone can see what was decided, but no one can say why.

## A Tuesday afternoon

Maya is a PM. A client emails: "Can we ship single sign-on by the end of the month?"

Maya doesn't know. The answer lives in three places. The scope is in an email thread from two weeks ago. The estimate is in a Drive doc. The real constraint is in the code, and only Dev knows that part.

So Maya pings Dev. Dev is deep in a bug. He stops, digs up context he already explained last sprint, and types a long reply. Maya forwards a polished version to the client. Tomorrow, a different PM asks Dev a similar question.

Nothing here is broken. It is just slow, and it taxes the people whose time is the most expensive. The knowledge exists. It is scattered across inboxes, chat history, folders, and one person's head, and every question pays the cost of gathering it again.

## The same afternoon, with project-os

Maya types in the project's Discord channel:

> @agent can we ship SSO by end of month?

1. **A thin adapter hears her.** The Discord adapter does nothing clever. It turns the message into a standard shape and hands it to the Coordinator.
2. **The Coordinator knows where it is.** This channel belongs to exactly one **Project**. The Coordinator loads that project's instructions, sources, and **Project Memory** (the durable facts the team has accumulated).
3. **The work becomes a Ticket.** The Coordinator classifies the intent, opens a **Ticket**, and marks it `assigned`. It never pushes work into anyone. It just posts the work on the board.
4. **A Worker picks it up.** On Dev's machine, a small **Watcher** polls the Coordinator. It sees an unclaimed ticket and starts a Claude Code session. That session claims the ticket, reads the project memory, does the research, and writes its findings back onto the ticket. It never talks to Discord.
5. **The Coordinator replies.** It reads the result from the ticket, decides what is worth surfacing, and tells the adapter to post the answer in the channel.

Maya gets a cited answer. Dev never saw a ping. The next time someone asks a related question, the finding is already in Project Memory.

## Why it is built this way

The shape of the system comes from a few choices. Each one removes a way this kind of agent usually goes wrong.

**The Project is the unit of context.** Chat, memory, sources, and instructions all live inside a Project. One Discord channel maps to exactly one Project, so the agent never has to guess whose context it is using.

**The Ticket is the only conversation.** All status, follow-ups, and results live on the ticket, like a real work ticket. The channel only sees what the Coordinator chooses to surface, the same way a client sees curated updates from a PM and not the internal chatter.

**Workers pull, the Coordinator never pushes.** A Worker lists tickets assigned to it and claims one with an atomic `assigned → in_progress` step. Two Workers can never take the same ticket. A Worker can be a local Claude Code on a laptop or a Daytona sandbox. The Coordinator doesn't care.

**Only the Coordinator talks to the outside.** Channels, the database, and every outbound message go through one service. Adapters have no business logic. Workers have no channel access. The surface that can say the wrong thing to a customer is small and in one place.

**Workers speak MCP.** Everything a Worker can do is a tool call: read or append to a ticket, read or write Project Memory. Nothing else.

See [technical-architecture.md](reference/architecture.md) for the design and [../CONTEXT.md](../../CONTEXT.md) for the vocabulary.
