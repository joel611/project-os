import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// A PM drops files into Discord with a request. The Ticket keeps refs to them (never the
// expiring CDN link) and the message that holds them.

const CHANNEL = "chan-1";
const pm: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Pat" };
const hero = {
  id: "att-1",
  name: "hero.png",
  contentType: "image/png",
  size: 2048,
  url: "https://cdn.discordapp.com/attachments/1/att-1/hero.png?ex=1&is=2&hm=3",
};

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let projectId: string;

beforeEach(async () => {
  stack = await startStack({ classifier });
  const { secret } = await stack.registerSharedWorker();
  mcp = await stack.worker(secret);
  projectId = await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string, id: string, withFiles = true) => {
  const inbound = fakeInbound(who, content, {
    id,
    ...(withFiles ? { attachments: [hero] } : {}),
  });
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};
const tool = async (name: string, args: Record<string, unknown>) =>
  ((await mcp.callTool({ name, arguments: args })) as { structuredContent?: any })
    .structuredContent;
const tickets = (): Promise<Array<{ id: string }>> =>
  stack.json("GET", `/projects/${projectId}/tickets`);
const events = async (ticketId: string) =>
  (await tool("ticket_get", { ticketId })).events as Array<{ type: string; payload: any }>;

describe("attachments on a ticket", () => {
  it("records refs and the source message on the created event, without the CDN link", async () => {
    await say(pm, "swap the hero image for this", "msg-1");

    const [ticket] = await tickets();
    const created = (await events(ticket!.id)).find((e) => e.type === "created")!;
    expect(created.payload.attachments).toEqual([
      { id: "att-1", filename: "hero.png", contentType: "image/png", size: 2048 },
    ]);
    expect(created.payload.message).toEqual({ channelId: CHANNEL, messageId: "msg-1" });
    expect(JSON.stringify(created.payload)).not.toContain("cdn.discordapp.com");
  });

  it("records files sent as a follow-up in the ticket thread against the thread message", async () => {
    await say(pm, "swap the hero image", "msg-1", false);
    const [ticket] = await tickets();

    await say({ ...pm, threadId: "discord-thread-1" }, "here is the new one", "msg-2");

    const followUp = (await events(ticket!.id)).find((e) => e.type === "follow_up")!;
    expect(followUp.payload.attachments).toHaveLength(1);
    expect(followUp.payload.message).toEqual({ channelId: "discord-thread-1", messageId: "msg-2" });
  });
});
