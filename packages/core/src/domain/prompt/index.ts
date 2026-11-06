import {
  APPROVAL_OPTIONS,
  type Prompt,
  type PromptKind,
  PROMPT_MAX_OPTIONS,
  PROMPT_OPTION_MAX_LENGTH,
} from "@project-os/contracts";
import { Data, Effect } from "effect";

export type { Prompt, PromptKind };

export class PromptNotFound extends Data.TaggedError("PromptNotFound")<{
  readonly promptId: string;
}> {}

/** The question or its options can't be shown (too few, too many, too long, duplicated). */
export class InvalidPrompt extends Data.TaggedError("InvalidPrompt")<{
  readonly message: string;
}> {}

/** There's nowhere to ask: the ticket has no thread and its project no default channel. */
export class NoPromptChannel extends Data.TaggedError("NoPromptChannel")<{
  readonly ticketId: string;
  readonly message: string;
}> {}

/** The options people pick from: fixed for `approval`, checked against Discord's limits for `choice`. */
export const promptOptions = (
  kind: PromptKind,
  options: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string>, InvalidPrompt> => {
  if (kind === "approval") return Effect.succeed(APPROVAL_OPTIONS);
  const labels = (options ?? []).map((o) => o.trim());
  const fail = (message: string) => Effect.fail(new InvalidPrompt({ message }));
  if (labels.length < 2) return fail("A choice needs at least 2 options.");
  if (labels.length > PROMPT_MAX_OPTIONS) {
    return fail(`A choice can have at most ${PROMPT_MAX_OPTIONS} options.`);
  }
  if (labels.some((l) => l === "" || l.length > PROMPT_OPTION_MAX_LENGTH)) {
    return fail(`Each option must be 1 to ${PROMPT_OPTION_MAX_LENGTH} characters.`);
  }
  if (new Set(labels).size !== labels.length) return fail("Options must be different.");
  return Effect.succeed(labels);
};

/** Text of the message that carries the buttons. */
export const promptContent = (prompt: Pick<Prompt, "kind" | "question">): string =>
  `${prompt.kind === "approval" ? "**Approval needed**" : "**Question**"}\n${prompt.question}`;

/** Text the prompt message is replaced with once answered (the buttons go away). */
export const answeredContent = (prompt: Prompt): string => {
  const answer = prompt.answer;
  if (!answer) return promptContent(prompt);
  const who = answer.by.name ?? `<@${answer.by.id}>`;
  const outcome =
    prompt.kind === "approval"
      ? answer.choice === 0
        ? `✅ Approved by ${who}`
        : `❌ Denied by ${who}`
      : `☑️ ${who} chose **${answer.label}**`;
  return `${promptContent(prompt)}\n\n${outcome}`;
};
