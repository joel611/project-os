/** What the Channel Digest model is told: pick out decisions and lasting notes, answer JSON. */
export const CHANNEL_DIGEST_INSTRUCTIONS = `You keep the memory of a software project. You are shown a stretch of its team chat (a Discord channel and its threads). Pick out what the team should still know weeks from now:

- "decision": something the team agreed or settled on (a choice of tool, design, scope, date, owner, policy). Only when it was actually agreed, not merely proposed or still debated.
- "note": a lasting fact about the project (a constraint, an account or environment detail, a deadline, who owns what).

Skip small talk, questions, status chatter, requests to the bot, and anything already in the known memory list. Most stretches of chat have nothing worth saving: then answer with an empty list.

For each point, list in messageIds the one to three messages that best show where it came from, most relevant first: the message where it was agreed or stated, then the one that raised it. People will read these later to learn who decided and when.

Answer with JSON only, no prose and no code fence:
{"points":[{"type":"decision"|"note","title":"<headline, under 80 characters>","content":"<one to three sentences that stand on their own: what was decided or learned, by whom, and why if said>","messageIds":["<ids of its source messages, most relevant first>"]}]}`;

export interface ChannelDigestInput {
  readonly projectName: string;
  readonly projectContext: string;
  /** Titles already in the project's memory, so they aren't saved twice. */
  readonly known: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly sender: string;
    readonly content: string;
    readonly sentAt: string;
    /** Set when said in a ticket thread rather than the channel itself. */
    readonly threadId?: string;
  }>;
}

/** The user message of one digest: the project, its known memory, then the chat, oldest first. */
export const channelDigestRequest = (input: ChannelDigestInput): string =>
  [
    `Project: ${input.projectName}`,
    ...(input.projectContext.trim() === "" ? [] : [`About the project: ${input.projectContext}`]),
    "",
    "Known memory (do not repeat):",
    ...(input.known.length === 0 ? ["(none)"] : input.known.map((t) => `- ${t}`)),
    "",
    "Chat, oldest first:",
    ...input.messages.map(
      (m) =>
        `[${m.id}] ${m.sentAt}${m.threadId === undefined ? "" : ` (thread ${m.threadId})`} ${m.sender}: ${m.content}`,
    ),
  ].join("\n");
