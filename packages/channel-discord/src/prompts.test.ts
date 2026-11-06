import type { PromptInstruction } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { fakePromptClick } from "./fake.ts";
import {
  answerPromptClick,
  normalizePromptClick,
  promptComponents,
  type PromptReplier,
} from "./prompts.ts";

const instruction = (over: Partial<PromptInstruction> = {}): PromptInstruction => ({
  channelType: "discord",
  channelId: "c1",
  promptId: "p1",
  kind: "approval",
  content: "**Approval needed**\nShip?",
  options: ["Approve", "Deny"],
  ...over,
});

const click = {
  id: "i1",
  customId: "prompt:p1:1",
  channelId: "c1",
  channel: { isThread: () => false },
  user: { id: "u1", username: "ada" },
  member: { displayName: "Ada" },
};

describe("promptComponents", () => {
  it("renders an approval as a green Approve and a red Deny button", () => {
    expect(promptComponents(instruction())).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Approve", custom_id: "prompt:p1:0" },
          { type: 2, style: 4, label: "Deny", custom_id: "prompt:p1:1" },
        ],
      },
    ]);
  });

  it("renders up to 5 short options as buttons", () => {
    const [row] = promptComponents(
      instruction({ kind: "choice", options: ["a", "b", "c", "d", "e"] }),
    );
    expect(row!.components.map((c) => c.type)).toEqual([2, 2, 2, 2, 2]);
  });

  it("switches to a select menu for more than 5 options or a long label", () => {
    const many = promptComponents(
      instruction({ kind: "choice", options: ["a", "b", "c", "d", "e", "f"] }),
    );
    expect(many[0]!.components).toEqual([
      expect.objectContaining({
        type: 3,
        custom_id: "prompt:p1",
        options: ["a", "b", "c", "d", "e", "f"].map((label, i) => ({ label, value: String(i) })),
      }),
    ]);
    const long = promptComponents(instruction({ kind: "choice", options: ["a", "x".repeat(81)] }));
    expect(long[0]!.components[0]!.type).toBe(3);
  });
});

describe("normalizePromptClick", () => {
  it("reads a button click", () => {
    expect(normalizePromptClick(click)).toEqual({
      channelType: "discord",
      promptId: "p1",
      choice: 1,
      externalId: "i1",
      channelId: "c1",
      sender: { id: "u1", name: "Ada" },
    });
  });

  it("reads a select menu pick and a thread", () => {
    const answer = normalizePromptClick({
      ...click,
      customId: "prompt:p1",
      values: ["3"],
      channelId: "th1",
      channel: { isThread: () => true, parentId: "c1" },
    });
    expect(answer).toMatchObject({ promptId: "p1", choice: 3, channelId: "c1", threadId: "th1" });
  });

  it("ignores components that aren't prompts, or are malformed", () => {
    expect(normalizePromptClick({ ...click, customId: "other:1" })).toBeNull();
    expect(normalizePromptClick({ ...click, customId: "prompt:p1:x" })).toBeNull();
    expect(normalizePromptClick({ ...click, customId: "prompt:p1", values: [] })).toBeNull();
    expect(normalizePromptClick({ ...click, channelId: null })).toBeNull();
  });

  it("falls back to the username, and to the thread itself without a parent", () => {
    const answer = normalizePromptClick({
      ...click,
      member: null,
      channelId: "th1",
      channel: { isThread: () => true, parentId: null },
    });
    expect(answer).toMatchObject({ channelId: "th1", threadId: "th1", sender: { name: "ada" } });
    expect(normalizePromptClick({ ...click, channel: null })).toMatchObject({ channelId: "c1" });
  });

  it("finds nothing to click without components", () => {
    expect(fakePromptClick({ channelId: "c1", userId: "u1", name: "Ada" }, [], 0)).toBeNull();
  });

  it("round-trips through the fake click for each kind of component", () => {
    const speaker = { channelId: "c1", userId: "u1", name: "Ada" };
    for (const options of [
      ["a", "b"],
      ["a", "b", "c", "d", "e", "f"],
    ]) {
      const comps = promptComponents(instruction({ kind: "choice", options }));
      expect(fakePromptClick(speaker, comps, 1)).toMatchObject({ promptId: "p1", choice: 1 });
    }
  });
});

describe("answerPromptClick", () => {
  const recorder = () => {
    const calls: string[] = [];
    const replier: PromptReplier = {
      defer: async () => void calls.push("defer"),
      close: async (c) => void calls.push(`close:${c}`),
      whisper: async (c) => void calls.push(`whisper:${c}`),
    };
    return { calls, replier };
  };
  const answer = normalizePromptClick(click)!;
  const respond =
    (body: unknown, status = 200) =>
    async (req: Request) => {
      expect(new URL(req.url).pathname).toBe("/prompts/answer");
      return new Response(JSON.stringify(body), { status });
    };

  it("closes the prompt when the Coordinator accepts the answer", async () => {
    const { calls, replier } = recorder();
    await answerPromptClick(answer, replier, {
      coordinatorUrl: "http://co/",
      fetcher: respond({ accepted: true, content: "done" }),
    });
    expect(calls).toEqual(["defer", "close:done"]);
  });

  it("whispers a refusal, or a failure to reach the Coordinator", async () => {
    const refused = recorder();
    await answerPromptClick(answer, refused.replier, {
      coordinatorUrl: "http://co",
      fetcher: respond({ accepted: false, content: "nope" }),
    });
    expect(refused.calls).toEqual(["defer", "whisper:nope"]);

    const down = recorder();
    await answerPromptClick(answer, down.replier, {
      coordinatorUrl: "http://co",
      fetcher: respond({}, 500),
    });
    expect(down.calls[1]).toMatch(/^whisper:Something went wrong/);
  });
});
