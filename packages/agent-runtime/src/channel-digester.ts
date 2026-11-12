import type { Api, AssistantMessage, Context as ChatContext, Model } from "@earendil-works/pi-ai";
import { ChannelDigester, ChannelDigestError, type DigestPoint } from "@project-os/core";
import { Effect, Layer, Schema } from "effect";

/** The slice of pi-ai `Models` the digester needs. */
export interface CompleteClient {
  readonly completeSimple: (model: Model<Api>, context: ChatContext) => Promise<AssistantMessage>;
}

const SYSTEM_PROMPT = `You keep the memory of a software project. You are shown a stretch of its team chat (a Discord channel and its threads). Pick out what the team should still know weeks from now:

- "decision": something the team agreed or settled on (a choice of tool, design, scope, date, owner, policy). Only when it was actually agreed, not merely proposed or still debated.
- "note": a lasting fact about the project (a constraint, an account or environment detail, a deadline, who owns what).

Skip small talk, questions, status chatter, requests to the bot, and anything already in the known memory list. Most stretches of chat have nothing worth saving: then answer with an empty list.

Answer with JSON only, no prose and no code fence:
{"points":[{"type":"decision"|"note","title":"<headline, under 80 characters>","content":"<one to three sentences that stand on their own: what was decided or learned, by whom, and why if said>","messageIds":["<ids of the messages it came from>"]}]}`;

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

type DigestInput = Parameters<(typeof ChannelDigester)["Service"]["digest"]>[0];

export const digestPrompt = (input: DigestInput): string =>
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
            systemPrompt: SYSTEM_PROMPT,
            messages: [{ role: "user", content: digestPrompt(request), timestamp: Date.now() }],
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
