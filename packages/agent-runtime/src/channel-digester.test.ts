import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ChannelDigester } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { digestPrompt, makeChannelDigester, newModels, parseDigestAnswer } from "./index.ts";

const input = {
  projectName: "Acme",
  projectContext: "Web shop",
  known: ["Use Bun"],
  messages: [
    { id: "m1", sender: "Ada", content: "SQLite or Postgres?", sentAt: "2026-11-12T10:00:00Z" },
    {
      id: "m2",
      sender: "Bob",
      content: "agreed, SQLite",
      sentAt: "2026-11-12T10:01:00Z",
      threadId: "t1",
    },
  ],
};

/** A chat model that answers `text`; records each request. */
const answering = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") => {
  const models = newModels();
  const model = models.getModel("openrouter", "anthropic/claude-sonnet-4.5")!;
  const requests: unknown[] = [];
  const client = {
    completeSimple: async (_m: unknown, context: unknown): Promise<AssistantMessage> => {
      requests.push(context);
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {} as AssistantMessage["usage"],
        stopReason,
        timestamp: 0,
      };
    },
  };
  const run = Effect.flatMap(ChannelDigester, (d) => d.digest(input)).pipe(
    Effect.provide(makeChannelDigester({ client, model })),
  );
  return { requests, run };
};

describe("channel digester", () => {
  it("shows the model the project, what memory has, and each message with its id", () => {
    const prompt = digestPrompt(input);
    expect(prompt).toContain("Project: Acme");
    expect(prompt).toContain("- Use Bun");
    expect(prompt).toContain("[m2] 2026-11-12T10:01:00Z (thread t1) Bob: agreed, SQLite");
  });

  it("reads the points, dropping message ids the chat doesn't have", async () => {
    const { run, requests } = answering(
      '```json\n{"points":[{"type":"decision","title":"Use SQLite","content":"Bob agreed on SQLite.","messageIds":["m2","m99"]}]}\n```',
    );
    expect(await Effect.runPromise(run)).toEqual([
      {
        type: "decision",
        title: "Use SQLite",
        content: "Bob agreed on SQLite.",
        messageIds: ["m2"],
      },
    ]);
    expect(requests).toHaveLength(1);
  });

  it("fails with ChannelDigestError on a bad answer or a provider error", async () => {
    const bad = await Effect.runPromise(Effect.flip(answering("nothing to save").run));
    expect(bad._tag).toBe("ChannelDigestError");
    const failed = await Effect.runPromise(Effect.flip(answering("", "error").run));
    expect(failed.message).toBe("digest error");
  });

  it("drops empty points", () => {
    expect(
      parseDigestAnswer('{"points":[{"type":"note","title":" ","content":"x","messageIds":[]}]}'),
    ).toEqual([]);
  });
});
