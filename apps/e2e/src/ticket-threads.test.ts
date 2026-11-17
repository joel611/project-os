import {
  IntentClassifier,
  THREAD_OPENED_MESSAGE,
  TICKET_CLOSED_MESSAGE,
  TICKET_REOPENED_MESSAGE,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// A new request opens a Discord thread on its message; everything said in that thread
// belongs to the ticket, and the ticket's result is posted back there.

/** The shared worker an admin registered; set once the stack is up. */
let WORKER: string;
let SECRET: string;
const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada" };

// Reads the intent off the message, so one stack can see every kind of message.
const classifier = Layer.succeed(IntentClassifier, {
  classify: ({ content }) =>
    Effect.succeed(
      content.startsWith("status")
        ? { intent: "status_question", confidence: 1 }
        : content.startsWith("also")
          ? { intent: "follow_up", confidence: 1 }
          : content.startsWith("uhh")
            ? { intent: "new_request", confidence: 0.1 }
            : { intent: "new_request", confidence: 1 },
    ),
});

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let projectId: string;

beforeEach(async () => {
  stack = await startStack({ classifier });
  ({ workerId: WORKER, secret: SECRET } = await stack.registerSharedWorker());
  mcp = await stack.worker(SECRET);
  projectId = await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string, id?: string) => {
  const inbound = fakeInbound(who, content, id ? { id } : {});
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};
const tool = async (name: string, args: Record<string, unknown>) =>
  ((await mcp.callTool({ name, arguments: args })) as { structuredContent?: any })
    .structuredContent;
const tickets = () => stack.json("GET", `/projects/${projectId}/tickets`);
const events = async (ticketId: string) =>
  (await tool("ticket_get", { ticketId })).events as Array<{ type: string; body: string }>;

const inThread = (threadId: string): FakeSpeaker => ({ ...ada, threadId });

describe("ticket threads", () => {
  it("opens a thread on the message that created the ticket and says so there", async () => {
    await say(ada, "please add dark mode", "msg-1");

    expect(stack.createdThreads).toEqual([
      { channelId: CHANNEL, messageId: "msg-1", name: "please add dark mode" },
    ]);
    expect(stack.posted).toEqual([
      {
        target: { channelId: CHANNEL, threadId: "discord-thread-1" },
        content: THREAD_OPENED_MESSAGE,
      },
    ]);
  });

  it("adds anything said in the thread to that ticket, even if it reads like a new request", async () => {
    await say(ada, "please add dark mode");
    await say(ada, "and a light mode toggle"); // new ticket, its own thread
    const [dark, light] = await tickets().then((all) =>
      ["please add dark mode", "and a light mode toggle"].map((title) =>
        all.find((t: { title: string }) => t.title === title)!,
      ),
    );

    // Said in the first ticket's thread, although the second ticket is the latest one.
    await say(inThread("discord-thread-1"), "make it the default too");

    expect(await tickets()).toHaveLength(2);
    expect((await events(dark.id)).filter((e) => e.type === "follow_up")).toEqual([
      expect.objectContaining({ body: "make it the default too" }),
    ]);
    expect((await events(light.id)).some((e) => e.type === "follow_up")).toBe(false);
  });

  it("keeps a low-confidence message in the thread on its ticket instead of asking", async () => {
    await say(ada, "please add dark mode");
    const [ticket] = await tickets();
    stack.posted.length = 0;

    await say(inThread("discord-thread-1"), "uhh the blue one");

    expect(stack.posted).toEqual([]);
    expect((await events(ticket.id)).at(-1)).toMatchObject({
      type: "follow_up",
      body: "uhh the blue one",
    });
  });

  it("answers a status question in the thread about that ticket only", async () => {
    await say(ada, "please add dark mode");
    await say(ada, "fix the login bug");
    stack.posted.length = 0;

    await say(inThread("discord-thread-2"), "status?");

    expect(stack.posted).toHaveLength(1);
    expect(stack.posted[0]!.target).toEqual({ channelId: CHANNEL, threadId: "discord-thread-2" });
    expect(stack.posted[0]!.content).toContain("fix the login bug");
    expect(stack.posted[0]!.content).not.toContain("dark mode");
  });

  it("posts the result in the ticket's thread, and a follow-up there reopens the ticket", async () => {
    await say(ada, "please add dark mode");
    const [ticket] = await tickets();
    await tool("ticket_claim", { ticketId: ticket.id, workerId: WORKER });
    await tool("ticket_update_status", { ticketId: ticket.id, status: "completed" });

    const result = stack.posted.at(-1)!;
    expect(result.target).toEqual({ channelId: CHANNEL, threadId: "discord-thread-1" });
    expect(result.content).toContain("please add dark mode");

    await say(inThread("discord-thread-1"), "one more thing");
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: "discord-thread-1" },
      content: TICKET_REOPENED_MESSAGE,
    });
    expect(await tickets()).toHaveLength(1);
    const [reopened] = await tickets();
    expect(reopened).toMatchObject({ id: ticket.id, status: "assigned", workerId: WORKER });
    expect((await events(ticket.id)).map((e) => [e.type, e.body])).toEqual(
      expect.arrayContaining([
        ["follow_up", "one more thing"],
        ["system", "Reopened by a follow-up (was completed)"],
      ]),
    );

    // The Worker picks it up again, and the second result is posted in the thread too.
    stack.posted.length = 0;
    await tool("ticket_claim", { ticketId: ticket.id, workerId: WORKER });
    await tool("ticket_update_status", { ticketId: ticket.id, status: "completed" });
    expect(stack.posted).toHaveLength(1);
    expect(stack.posted[0]!.target).toEqual({ channelId: CHANNEL, threadId: "discord-thread-1" });
  });

  it("keeps a cancelled ticket's thread closed to follow-ups", async () => {
    await say(ada, "please add dark mode");
    const [ticket] = await tickets();
    await tool("ticket_update_status", { ticketId: ticket.id, status: "cancelled" });

    await say(inThread("discord-thread-1"), "one more thing");
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: "discord-thread-1" },
      content: TICKET_CLOSED_MESSAGE,
    });
    const [after] = await tickets();
    expect(after).toMatchObject({ status: "cancelled" });
  });

  it("uses the thread a new request was made in instead of opening another", async () => {
    await say(inThread("user-thread"), "please add dark mode");

    expect(stack.createdThreads).toEqual([]);
    expect(stack.posted.map((p) => p.target)).toEqual([
      { channelId: CHANNEL, threadId: "user-thread" },
    ]);
    await say(inThread("user-thread"), "add a toggle too");
    const [ticket] = await tickets();
    expect(await tickets()).toHaveLength(1);
    expect((await events(ticket.id)).at(-1)).toMatchObject({ type: "follow_up" });
  });

  it("still adds a main-channel follow-up to the latest ticket", async () => {
    await say(ada, "please add dark mode");
    const [ticket] = await tickets();
    await say(ada, "also make it blue");
    expect((await events(ticket.id)).at(-1)).toMatchObject({
      type: "follow_up",
      body: "also make it blue",
    });
  });
});
