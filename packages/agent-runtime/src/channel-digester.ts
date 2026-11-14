import type { Api, AssistantMessage, Context as ChatContext, Model } from "@earendil-works/pi-ai";
import { ChannelDigester, ChannelDigestError, type DigestPoint } from "@project-os/core";
import { CHANNEL_DIGEST_INSTRUCTIONS, channelDigestRequest } from "@project-os/system-prompts";
import { Effect, Layer, Schema } from "effect";

/** The slice of pi-ai `Models` the digester needs. */
export interface CompleteClient {
  readonly completeSimple: (model: Model<Api>, context: ChatContext) => Promise<AssistantMessage>;
}

const Answer = Schema.Struct({
  points: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["decision", "note"]),
      title: Schema.String,
      content: Schema.String,
      messageIds: Schema.Array(Schema.String),
    }),
  ),
});

/** Reads the model's JSON answer, tolerating a code fence or text around the object. */
export const parseDigestAnswer = (text: string): ReadonlyArray<DigestPoint> => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the answer");
  const answer = Schema.decodeUnknownSync(Answer)(JSON.parse(text.slice(start, end + 1)));
  return answer.points.filter((p) => p.title.trim() !== "" && p.content.trim() !== "");
};

/** A chat model behind the `ChannelDigester` port: one completion per digest. */
export const makeChannelDigester = (input: {
  readonly client: CompleteClient;
  readonly model: Model<Api>;
}) =>
  Layer.succeed(ChannelDigester, {
    digest: (request) =>
      Effect.tryPromise({
        try: async () => {
          const answer = await input.client.completeSimple(input.model, {
            systemPrompt: CHANNEL_DIGEST_INSTRUCTIONS,
            messages: [
              { role: "user", content: channelDigestRequest(request), timestamp: Date.now() },
            ],
          });
          if (answer.stopReason !== "stop") {
            throw new Error(answer.errorMessage ?? `digest ${answer.stopReason}`);
          }
          const text = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("");
          const known = new Set(request.messages.map((m) => m.id));
          return parseDigestAnswer(text).map((p) => ({
            ...p,
            messageIds: p.messageIds.filter((id) => known.has(id)),
          }));
        },
        catch: (e) =>
          new ChannelDigestError({ message: e instanceof Error ? e.message : String(e) }),
      }),
  });
