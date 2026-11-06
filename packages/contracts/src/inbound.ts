import { Schema } from "effect";
import { ChannelType } from "./enums.ts";

export const InboundMessage = Schema.Struct({
  channelType: ChannelType,
  externalId: Schema.String,
  channelId: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  sender: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
  }),
  content: Schema.String,
  /**
   * True when the message @mentions the bot. Set by adapters that know it (Discord); the
   * Coordinator only acts on top-level project channel messages that mention the bot.
   */
  mentionsBot: Schema.optionalKey(Schema.Boolean),
  raw: Schema.Unknown,
  receivedAt: Schema.String,
});
export type InboundMessage = typeof InboundMessage.Type;

export const ReplyInstruction = Schema.Struct({
  channelType: ChannelType,
  channelId: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  content: Schema.String,
});
export type ReplyInstruction = typeof ReplyInstruction.Type;

/** Asks a Channel Adapter to create a new channel (e.g. a project's Discord channel). */
export const CreateChannelInstruction = Schema.Struct({
  channelType: ChannelType,
  name: Schema.String,
});
export type CreateChannelInstruction = typeof CreateChannelInstruction.Type;

/** The channel a Channel Adapter created. `name` is the platform's final spelling. */
export const CreatedChannel = Schema.Struct({
  channelId: Schema.String,
  name: Schema.String,
});
export type CreatedChannel = typeof CreatedChannel.Type;

/**
 * Asks a Channel Adapter to open a thread on a message, so a Ticket's conversation is grouped
 * there (Discord: a public thread started from the message).
 */
export const CreateThreadInstruction = Schema.Struct({
  channelType: ChannelType,
  /** Channel the message is in. */
  channelId: Schema.String,
  /** Platform id of the message to start the thread from (the inbound `externalId`). */
  messageId: Schema.String,
  name: Schema.String,
});
export type CreateThreadInstruction = typeof CreateThreadInstruction.Type;

/** The thread a Channel Adapter opened. */
export const CreatedThread = Schema.Struct({ threadId: Schema.String });
export type CreatedThread = typeof CreatedThread.Type;

/**
 * Asks a Channel Adapter to react to a message, e.g. 👀 to show the Coordinator took it in.
 * `threadId` is set when the message was posted inside a thread.
 */
export const ReactInstruction = Schema.Struct({
  channelType: ChannelType,
  channelId: Schema.String,
  threadId: Schema.optional(Schema.String),
  /** Platform id of the message to react to (the inbound `externalId`). */
  messageId: Schema.String,
  /** Unicode emoji. */
  emoji: Schema.String,
});
export type ReactInstruction = typeof ReactInstruction.Type;

/** Slash commands a Channel Adapter registers and forwards to the Coordinator's `/commands`. */
export const SLASH_COMMANDS = [
  "project-create",
  "connect",
  "disconnect",
  "connections",
  "register-worker",
  "workers",
  "unregister-worker",
] as const;
export const SlashCommandName = Schema.Literals(SLASH_COMMANDS);
export type SlashCommandName = typeof SlashCommandName.Type;

/** A slash command someone ran, normalized by its Channel Adapter. */
export const SlashCommand = Schema.Struct({
  channelType: ChannelType,
  command: SlashCommandName,
  /** Platform id of this invocation (Discord interaction id). */
  externalId: Schema.String,
  channelId: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  sender: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) }),
  /** The command's string options, by name. */
  options: Schema.Record(Schema.String, Schema.String),
});
export type SlashCommand = typeof SlashCommand.Type;

/** The Coordinator's answer to a slash command; the adapter shows it to whoever ran it. */
export const CommandReply = Schema.Struct({
  content: Schema.String,
  /** True when only the person who ran the command should see it (e.g. a refusal). */
  ephemeral: Schema.Boolean,
});
export type CommandReply = typeof CommandReply.Type;

/**
 * A Watcher trading the one-time code from /register-worker for its device credentials
 * (`POST /workers/register`). The code is the only proof needed, so it is short-lived and
 * works once.
 */
export const WorkerRegisterRequest = Schema.Struct({
  token: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
  hostname: Schema.optionalKey(Schema.String),
});
export type WorkerRegisterRequest = typeof WorkerRegisterRequest.Type;

export const WorkerRegisterResponse = Schema.Struct({
  workerId: Schema.String,
  name: Schema.String,
  /** Bearer secret for `/mcp`. Shown once; the Coordinator keeps only its hash. */
  secret: Schema.String,
});
export type WorkerRegisterResponse = typeof WorkerRegisterResponse.Type;
