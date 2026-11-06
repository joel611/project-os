import { Schema } from "effect";
import { ChannelType } from "./enums.ts";

// Prompts: a question the Coordinator puts to people in a channel, answered with a click.
// `approval` is Approve / Deny; `choice` is one pick among 2–25 options.

export const PromptKind = Schema.Literals(["approval", "choice"]);
export type PromptKind = typeof PromptKind.Type;

/** The fixed options of an `approval` prompt, in this order (choice 0 approves). */
export const APPROVAL_OPTIONS = ["Approve", "Deny"] as const;

/** Discord limits: 25 options in a select menu, 100 characters per option label. */
export const PROMPT_MAX_OPTIONS = 25;
export const PROMPT_OPTION_MAX_LENGTH = 100;

export const PromptStatus = Schema.Literals(["pending", "answered"]);
export type PromptStatus = typeof PromptStatus.Type;

export const PromptAnswerRecord = Schema.Struct({
  /** Index into `options`. */
  choice: Schema.Int,
  label: Schema.String,
  by: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  at: Schema.String,
});
export type PromptAnswerRecord = typeof PromptAnswerRecord.Type;

/** A question the Coordinator asked, and its answer once someone clicked. */
export const Prompt = Schema.Struct({
  id: Schema.NonEmptyString,
  /** Ticket the question is about; its answer is added to the ticket as a `follow_up`. */
  ticketId: Schema.NullOr(Schema.String),
  kind: PromptKind,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  status: PromptStatus,
  answer: Schema.NullOr(PromptAnswerRecord),
  channelType: ChannelType,
  channelId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  /** Platform id of the message holding the buttons, once posted. */
  messageId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type Prompt = typeof Prompt.Type;

/**
 * Asks a Channel Adapter to post a question people answer with a click (Discord: buttons, or
 * a select menu when there are many options). `content` is the message text to show.
 */
export const PromptInstruction = Schema.Struct({
  channelType: ChannelType,
  channelId: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  promptId: Schema.NonEmptyString,
  kind: PromptKind,
  content: Schema.String,
  options: Schema.Array(Schema.String),
});
export type PromptInstruction = typeof PromptInstruction.Type;

/** The message a Channel Adapter posted for a prompt. */
export const PostedPrompt = Schema.Struct({ messageId: Schema.String });
export type PostedPrompt = typeof PostedPrompt.Type;

/** Someone clicked an option of a prompt; the adapter forwards it to `POST /prompts/answer`. */
export const PromptAnswer = Schema.Struct({
  channelType: ChannelType,
  promptId: Schema.NonEmptyString,
  /** Index into the prompt's options. */
  choice: Schema.Int,
  /** Platform id of the click (Discord interaction id). */
  externalId: Schema.String,
  channelId: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  sender: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) }),
});
export type PromptAnswer = typeof PromptAnswer.Type;

/**
 * The Coordinator's answer to a click. `accepted`: `content` replaces the prompt message and
 * its buttons go away. Otherwise `content` is shown only to whoever clicked (already answered,
 * expired, not allowed), and the buttons stay.
 */
export const PromptAnswerReply = Schema.Struct({
  accepted: Schema.Boolean,
  content: Schema.String,
});
export type PromptAnswerReply = typeof PromptAnswerReply.Type;
