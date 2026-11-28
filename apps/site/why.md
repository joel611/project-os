# Why project-os

## Background

A project's story rarely lives in one place. Conversations with the client sit in email. The team talks things over in its own chat. Tasks and issues are tracked in a ticket system. Each holds a piece of the picture, and nothing joins them together.

So people become the link. The longer a project runs, the more it depends on who remembers what. When that person is busy, away, or has moved on, answers are hard to find. Sometimes the reason behind a past decision can't be traced at all: everyone can see what was decided, but no one can say why.

## Three everyday scenarios

Each one below is a normal request. First the way most teams handle it, then the way project-os handles it. The [home page](/) plays all three as animations.

### A client asks for a PHP upgrade estimate

**Old way.** The client emails. The project manager reads it and can't answer alone, so they message a developer. The developer stops what they are doing, opens the repo, and asks their coding agent for the current version and the upgrade steps. They turn that into an estimate and send it back to the project manager.

**With project-os.** The email arrives in the project inbox. project-os reads it, opens a ticket, and starts a worker agent that reads the source code. The worker's findings and estimate are posted in the internal project channel. No one was pinged.

### Months later: why was it built this way?

A project manager asks for a feature. Developers discuss solutions in the team chat and make a decision. A couple of months later the team head asks why the feature was built that way.

**Old way.** The team head searches the chat room for a keyword, then reads through message after message, trying other keywords, hoping to find the discussion and who made the call.

**With project-os.** When the decision was made, project-os saved a memory point: what was decided, why, and by whom. Now the agent reads that memory point and replies in the channel with the reason and who decided.

### A simple copy update on the marketing site

**Old way.** The project manager writes a Jira ticket and assigns it to a developer. The developer checks out the latest source, asks Claude Code on their own computer to make the change, submits a pull request, and sends the preview link back to the project manager.

**With project-os.** The project manager asks the agent directly in the project channel. The Coordinator classifies it as a development task and opens a focus thread. It assigns the ticket to a shared worker, which implements the change and submits a PR. The PR pipeline deploys a preview, and the worker reports the preview link back through the Coordinator to the focus thread. The project manager then asks a developer to review. The developer reads the CI result and approves.

In all three, the people who are expensive to interrupt are no longer the router. The knowledge and the routine work sit in the project, not in someone's head.

## Why it is built this way

The shape of the system comes from a few choices. Each one removes a way this kind of agent usually goes wrong.

**The Project is the unit of context.** Chat, memory, sources, and instructions all live inside a Project. One Discord channel maps to exactly one Project, so the agent never has to guess whose context it is using.

**The Ticket is the only conversation.** All status, follow-ups, and results live on the ticket, like a real work ticket. The channel only sees what the Coordinator chooses to surface, the same way a client sees curated updates from a PM and not the internal chatter.

**Workers pull, the Coordinator never pushes.** A Worker lists tickets assigned to it and claims one with an atomic `assigned → in_progress` step. Two Workers can never take the same ticket. A Worker can be a local Claude Code on a laptop or a Daytona sandbox. The Coordinator doesn't care.

**Only the Coordinator talks to the outside.** Channels, the database, and every outbound message go through one service. Adapters have no business logic. Workers have no channel access. The surface that can say the wrong thing to a customer is small and in one place.

**Workers speak MCP.** Everything a Worker can do is a tool call: read or append to a ticket, read or write Project Memory. Nothing else.

See [technical-architecture.md](reference/architecture.md) for the design and [../CONTEXT.md](../../CONTEXT.md) for the vocabulary.
