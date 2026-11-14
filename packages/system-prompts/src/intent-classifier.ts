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
