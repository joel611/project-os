import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../discord-adapter/src/fake.ts";
import { forwardInbound } from "../../discord-adapter/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// Discord -> /inbound -> ticket -> MCP worker -> completion -> /reply, with no Discord.

const WORKER = "w1";
const CHANNEL = "chan-1";
const speaker: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada" };

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;

const boot = async (classifier: ReturnType<typeof classifierReturning>) => {
  stack = await startStack({ classifier, workerId: WORKER });
  mcp = await stack.worker();
};

afterEach(() => stack.stop());

const json = (method: string, path: string, body?: unknown) => stack.json(method, path, body);
const linkChannel = () => stack.linkChannel(CHANNEL);

const sayInDiscord = async (
  who: FakeSpeaker,
  content: string,
  id?: string,
  options: { mention?: boolean } = {},
) => {
  const inbound = fakeInbound(who, content, { ...(id && { id }), ...options });
  if (!inbound) return;
  await forwardInbound(stack.url, inbound, fetch);
};

const tool = async (name: string, args: Record<string, unknown>) =>
  ((await mcp.callTool({ name, arguments: args })) as { structuredContent?: any })
    .structuredContent;

describe("discord loop, no Discord", () => {
  describe("with a confident new_request classifier", () => {
    beforeEach(() => boot(classifierReturning("new_request")));

    it("turns a message into a ticket, and completing it replies in the channel", async () => {
      const projectId = await linkChannel();
      await sayInDiscord(speaker, "please add dark mode");

      const tickets = await json("GET", `/projects/${projectId}/tickets`);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({ title: "please add dark mode", workerId: WORKER });
      expect(stack.posted).toEqual([]);

      const assigned = await tool("ticket_list_assigned", { workerId: WORKER });
      const ticketId = assigned.tickets[0].id as string;
      expect(ticketId).toBe(tickets[0].id);
      await tool("ticket_claim", { ticketId, workerId: WORKER });
      await tool("ticket_append_event", {
        ticketId,
        type: "comment",
        actor: "worker",
        actorId: WORKER,
        body: "dark mode shipped",
      });
      await tool("ticket_update_status", { ticketId, status: "completed" });

      expect(stack.posted).toHaveLength(1);
      expect(stack.posted[0]!.target).toEqual({ channelId: CHANNEL });
      expect(stack.posted[0]!.content).toContain("please add dark mode");
      expect(stack.posted[0]!.content).toContain("dark mode shipped");
    });

    it("ignores a duplicate delivery of the same Discord message", async () => {
      const projectId = await linkChannel();
      await sayInDiscord(speaker, "build it", "dup-1");
      await sayInDiscord(speaker, "build it", "dup-1");
      expect(await json("GET", `/projects/${projectId}/tickets`)).toHaveLength(1);
    });

    it("ignores a project channel message that doesn't @mention the bot", async () => {
      const projectId = await linkChannel();
      await sayInDiscord(speaker, "chatting among ourselves", undefined, { mention: false });
      expect(await json("GET", `/projects/${projectId}/tickets`)).toEqual([]);
      expect(stack.posted).toEqual([]);
    });

    it("takes a message in a thread without a mention", async () => {
      const projectId = await linkChannel();
      await sayInDiscord({ ...speaker, threadId: "th-1" }, "and dark mode", undefined, {
        mention: false,
      });
      expect(await json("GET", `/projects/${projectId}/tickets`)).toHaveLength(1);
    });

    it("creates nothing for an unlinked channel", async () => {
      const projectId = await linkChannel();
      await sayInDiscord({ ...speaker, channelId: "other-chan" }, "hello?");
      expect(await json("GET", `/projects/${projectId}/tickets`)).toEqual([]);
      expect(stack.posted).toEqual([]);
    });
  });

  describe("with a low-confidence classifier", () => {
    beforeEach(() => boot(classifierReturning("new_request", 0.1)));

    it("asks a clarifying question in the same thread", async () => {
      const projectId = await linkChannel();
      await sayInDiscord({ ...speaker, threadId: "th-1" }, "uhh");

      expect(stack.posted).toHaveLength(1);
      expect(stack.posted[0]!.target).toEqual({ channelId: CHANNEL, threadId: "th-1" });
      expect(stack.posted[0]!.content).toContain("didn't catch that");
      expect(await json("GET", `/projects/${projectId}/tickets`)).toEqual([]);
    });
  });
});
