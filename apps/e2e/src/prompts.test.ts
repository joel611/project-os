import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  fakeInbound,
  fakePromptClick,
  type FakeSpeaker,
} from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { answerPromptClick } from "../../../packages/channel-discord/src/prompts.ts";
import { type Stack, startStack } from "./stack.ts";

// A Worker asks for confirmation (Approve / Deny) or a pick among options with `ticket_ask`.
// The Coordinator posts it in the ticket's thread with buttons; a click goes back through the
// adapter to the Coordinator, which closes the prompt and adds the answer to the ticket.

/** The shared worker an admin registered; set once the stack is up. */
let WORKER: string;
let SECRET: string;
const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada" };
const bob: FakeSpeaker = { channelId: CHANNEL, userId: "u2", name: "Bob" };
const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let ticketId: string;

const tool = async (name: string, args: Record<string, unknown>) => {
  const out = (await mcp.callTool({ name, arguments: args })) as {
    structuredContent?: any;
    isError?: boolean;
    content?: Array<{ text: string }>;
  };
  return out.isError ? { error: out.content?.[0]?.text } : out.structuredContent;
};

/** Clicks option `choice` of the latest prompt as `who`; returns what the adapter did. */
const click = async (who: FakeSpeaker, choice: number) => {
  const prompt = stack.prompts.at(-1)!;
  const answer = fakePromptClick(
    { ...who, threadId: prompt.target.threadId! },
    prompt.components,
    choice,
  );
  if (!answer) throw new Error(`no option ${choice}`);
  const seen: { closed?: string; whispered?: string } = {};
  await answerPromptClick(
    answer,
    {
      defer: async () => {},
      close: async (content) => void (seen.closed = content),
      whisper: async (content) => void (seen.whispered = content),
    },
    { coordinatorUrl: stack.url, fetcher: fetch },
  );
  return seen;
};

beforeEach(async () => {
  stack = await startStack({ classifier });
  ({ workerId: WORKER, secret: SECRET } = await stack.registerSharedWorker());
  mcp = await stack.worker(SECRET);
  await stack.linkChannel(CHANNEL);
  const inbound = fakeInbound(ada, "deploy the new pricing page", { id: "msg-1" })!;
  await forwardInbound(stack.url, inbound, fetch);
  const [ticket] = (await tool("ticket_list_assigned", { workerId: WORKER })).tickets;
  ticketId = ticket.id;
  await tool("ticket_claim", { ticketId, workerId: WORKER });
});
afterEach(() => stack.stop());

describe("prompts", () => {
  it("posts an approval in the ticket's thread with Approve and Deny buttons", async () => {
    const { prompt } = await tool("ticket_ask", {
      ticketId,
      kind: "approval",
      question: "Deploy to production now?",
    });

    expect(prompt).toMatchObject({ status: "pending", options: ["Approve", "Deny"] });
    expect(stack.prompts).toHaveLength(1);
    const posted = stack.prompts[0]!;
    expect(posted.target).toEqual({ channelId: CHANNEL, threadId: "discord-thread-1" });
    expect(posted.content).toBe("**Approval needed**\nDeploy to production now?");
    expect(posted.components[0]!.components).toEqual([
      { type: 2, style: 3, label: "Approve", custom_id: `prompt:${prompt.id}:0` },
      { type: 2, style: 4, label: "Deny", custom_id: `prompt:${prompt.id}:1` },
    ]);
    expect(prompt.messageId).toBe(posted.messageId);
  });

  it("closes the prompt on a click and hands the answer to the Worker", async () => {
    const { prompt } = await tool("ticket_ask", {
      ticketId,
      kind: "approval",
      question: "Deploy to production now?",
    });

    expect(await click(ada, 0)).toEqual({
      closed: "**Approval needed**\nDeploy to production now?\n\n✅ Approved by Ada",
    });

    const read = await tool("ticket_get_prompt", { promptId: prompt.id });
    expect(read.prompt).toMatchObject({
      status: "answered",
      answer: { choice: 0, label: "Approve", by: { id: "u1", name: "Ada" } },
    });
    const { events } = await tool("ticket_get", { ticketId });
    expect(events.at(-1)).toMatchObject({
      type: "follow_up",
      actorId: "u1",
      body: 'Answer to "Deploy to production now?": Approve',
      payload: expect.objectContaining({ promptId: prompt.id, choice: 0, label: "Approve" }),
    });
    expect(events.some((e: { body: string }) => e.body.startsWith("Asked: Deploy"))).toBe(true);
  });

  it("keeps the first answer and tells a later clicker who answered", async () => {
    await tool("ticket_ask", { ticketId, kind: "approval", question: "Ship it?" });
    await click(ada, 1);

    const late = await click(bob, 0);
    expect(late.closed).toBeUndefined();
    expect(late.whispered).toContain("Already answered");
    expect(late.whispered).toContain("❌ Denied by Ada");
    const { events } = await tool("ticket_get", { ticketId });
    expect(events.filter((e: { type: string }) => e.type === "follow_up")).toHaveLength(1);
  });

  it("shows a short multiple choice as buttons", async () => {
    await tool("ticket_ask", {
      ticketId,
      kind: "choice",
      question: "Which region?",
      options: ["EU", "US", "Asia"],
    });
    const row = stack.prompts[0]!.components[0]!.components;
    expect(row.map((c) => c.type === 2 && [c.label, c.style])).toEqual([
      ["EU", 1],
      ["US", 1],
      ["Asia", 1],
    ]);

    expect((await click(ada, 2)).closed).toBe(
      "**Question**\nWhich region?\n\n☑️ Ada chose **Asia**",
    );
  });

  it("shows a long multiple choice as a select menu", async () => {
    const options = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const { prompt } = await tool("ticket_ask", {
      ticketId,
      kind: "choice",
      question: "Which day should it go out?",
      options,
    });
    const [menu] = stack.prompts[0]!.components[0]!.components;
    expect(menu).toMatchObject({
      type: 3,
      custom_id: `prompt:${prompt.id}`,
      options: options.map((label, i) => ({ label, value: String(i) })),
    });

    await click(bob, 4);
    expect((await tool("ticket_get_prompt", { promptId: prompt.id })).prompt.answer).toMatchObject({
      label: "Fri",
      by: { name: "Bob" },
    });
  });

  it("refuses a choice without enough options, and posts nothing", async () => {
    const out = await tool("ticket_ask", {
      ticketId,
      kind: "choice",
      question: "Which?",
      options: ["only one"],
    });
    expect(out.error).toContain("InvalidPrompt");
    expect(stack.prompts).toEqual([]);
  });

  it("tells the clicker when the prompt is unknown", async () => {
    await tool("ticket_ask", { ticketId, kind: "approval", question: "Ship it?" });
    const prompt = stack.prompts[0]!;
    const forged = {
      ...prompt,
      components: [
        {
          type: 1 as const,
          components: [
            { type: 2 as const, style: 3 as const, label: "x", custom_id: "prompt:nope:0" },
          ],
        },
      ],
    };
    stack.prompts.push(forged);
    expect((await click(ada, 0)).whispered).toContain("expired");
  });
});
