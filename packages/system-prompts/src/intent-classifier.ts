// Jev, the intent classifier: one choice question per answer it gives, each option with the
// criteria it is judged by. The keys are the values the Coordinator acts on.

/** What a message wants. */
export const INTENT_CRITERIA = {
  new_request: "The user asks for new work to be done",
  follow_up: "The user adds to or changes an open request",
  status_question: "The user asks about the progress or result of existing work",
  remember: "The user asks to remember a fact about the project, to be kept in its memory",
  admin_command: "The user wants to configure projects, channels or sources",
  chit_chat: "Greeting, thanks or small talk",
  none: "None of the above",
} as const;

/** Who works a new request: a Worker in a checkout of the repo, or the read-only Sidekick. */
export const EXECUTOR_CRITERIA = {
  worker:
    "Needs the whole repository pulled, tests run, or a script run. Also any request that changes code or files, or that is unclear",
  sidekick:
    "Only needs read-only tool calls: listing Google Drive files, or reading a GitHub repo's status, commit history, pipelines or releases",
} as const;

export const INTENT_QUESTION = "What does the message want?";

export const EXECUTOR_QUESTION =
  "Who does this request? A Worker works in a checkout of the repo. The Sidekick only calls read-only Drive and GitHub tools. Only meaningful for new requests.";

/**
 * Asked only for a message said in a ticket's thread: is it about that ticket? The ticket is
 * described in the `ticket_context` state (see `ticketContext`).
 */
export const SCOPE_CRITERIA = {
  in_scope:
    "The message is about the ticket in ticket_context: it adds to, corrects, continues or asks about that work, even if the ticket is finished",
  out_of_scope:
    "The message asks for different work that has nothing to do with the ticket in ticket_context",
} as const;

export const SCOPE_QUESTION =
  "Is the message about the ticket described in ticket_context? Only meaningful when ticket_context is given.";

/** The longest part of a ticket's last result that goes into `ticket_context`. */
const RESULT_EXCERPT_MAX = 600;

/** The ticket a thread message was said in, as the classifier's `ticket_context`. */
export const ticketContext = (ticket: {
  readonly title: string;
  readonly inputSummary: string;
  readonly status: string;
  readonly lastResult?: string;
}): string => {
  const result =
    ticket.lastResult === undefined
      ? ""
      : `\nLast result: ${
          ticket.lastResult.length > RESULT_EXCERPT_MAX
            ? `${ticket.lastResult.slice(0, RESULT_EXCERPT_MAX)}…`
            : ticket.lastResult
        }`;
  return `Ticket: ${ticket.title}\nStatus: ${ticket.status}\nAsked: ${ticket.inputSummary}${result}`;
};
