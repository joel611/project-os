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
