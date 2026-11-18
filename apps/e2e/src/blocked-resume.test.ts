import { IntentClassifier, TICKET_RESUMED_MESSAGE } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import {
  fakeCommand,
  fakeInbound,
  fakePromptClick,
  type FakeSpeaker,
} from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { answerPromptClick } from "../../../packages/channel-discord/src/prompts.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A Worker that can't go on sets its ticket to blocked and ends its session: it needs the
// person to /connect an account, or to answer a ticket_ask. Their reply in the ticket's thread
// (or their click) puts the ticket back in the pull queue, so a Worker picks it up again.

let WORKER: string;
let SECRET: string;
const CHANNEL = "chan-1";
const THREAD = "discord-thread-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const inThread: FakeSpeaker = { ...ada, threadId: THREAD };

// "try again" reads as small talk; it must still resume a blocked ticket.
const classifier = Layer.succeed(IntentClassifier, {
  classify: ({ content }) =>
    Effect.succeed(
      content.startsWith("try")
        ? { intent: "chit_chat", confidence: 1 }
        : { intent: "new_request", confidence: 1 },
    ),
});

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let projectId: string;

beforeEach(async () => {
  stack = await startStack({ classifier, connections: true });
  ({ workerId: WORKER, secret: SECRET } = await stack.registerSharedWorker());
  mcp = await stack.worker(SECRET);
  projectId = await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string) => {
  const inbound = fakeInbound(who, content);
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};
const call = async (name: string, args: Record<string, unknown>) =>
  (await mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: any;
    content: Array<{ text: string }>;
  };
const tool = async (name: string, args: Record<string, unknown>) =>
  (await call(name, args)).structuredContent;
const tickets = () => stack.json("GET", `/projects/${projectId}/tickets`);
const events = async (ticketId: string) =>
  (await tool("ticket_get", { ticketId })).events as Array<{ type: string; body: string }>;

/** /connect from Discord, then the browser: one-time link → Continue → fake provider. */
const connect = async (provider: string) => {
  const reply = await forwardCommand(
    stack.coordinator,
    fakeCommand(ada, "connect", { provider })!,
    fetch,
  );
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  const page = await browse(link, undefined, "POST");
  expect(page.url).toContain(`/connect/done?provider=${provider}`);
};

/** A new request, claimed by the Worker: returns the ticket id. */
const startTicket = async (content: string) => {
  await say(ada, content);
  const [ticket] = await tickets();
  await tool("ticket_claim", { ticketId: ticket.id, workerId: WORKER });
  return ticket.id as string;
};

describe("blocked tickets", () => {
  it("asks to /connect in the thread, and a reply after connecting resumes the ticket", async () => {
    const ticketId = await startTicket("triage the open GitHub issues");

    // The Worker needs GitHub; Ada hasn't linked it, so she's asked in the ticket's thread.
    const denied = await call("user_token", { ticketId, provider: "github" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("NotConnected");
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: THREAD },
      content: expect.stringMatching(
        /^<@u-ada>, I need your GitHub access.*\(The Worker acted as <@u-ada> \(Ada\), the author/s,
      ),
    });
    await tool("ticket_update_status", {
      ticketId,
      status: "blocked",
      reason: "Ada hasn't connected GitHub, so I can't read acme/web.",
    });
    // The thread hears the Worker's reason, not only a generic line (the fake runtime echoes
    // the summary prompt, which quotes it).
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: THREAD },
      content: expect.stringMatching(
        /^Ticket "[^"]+" is blocked: .*Ada hasn't connected GitHub.*\nActing as <@u-ada> \(Ada\)\.\nReply here and I'll pick it back up\.$/s,
      ),
    });

    await connect("github");
    stack.posted.length = 0;
    await say(inThread, "try again");

    expect(stack.posted).toEqual([
      { target: { channelId: CHANNEL, threadId: THREAD }, content: TICKET_RESUMED_MESSAGE },
    ]);
    const [resumed] = await tickets();
    expect(resumed).toMatchObject({ id: ticketId, status: "assigned", workerId: WORKER });
    expect((await events(ticketId)).map((e) => [e.type, e.body])).toEqual(
      expect.arrayContaining([
        ["follow_up", "try again"],
        ["system", "Resumed by a follow-up (was blocked)"],
      ]),
    );

    // The Worker's next session claims it again, and Ada's GitHub token is there now.
    const [next] = (await tool("ticket_list_assigned", { workerId: WORKER })).tickets;
    expect(next.id).toBe(ticketId);
    await tool("ticket_claim", { ticketId, workerId: WORKER });
    const token = await call("user_token", { ticketId, provider: "github" });
    expect(token.isError).toBeFalsy();
    expect(token.structuredContent).toMatchObject({
      accessToken: "at-github-1",
      person: { channelType: "discord", id: "u-ada" },
    });
  });

  it("an answer to the Worker's question resumes the blocked ticket", async () => {
    const ticketId = await startTicket("deploy the new pricing page");
    await tool("ticket_ask", {
      ticketId,
      kind: "approval",
      question: "Deploy to production now?",
    });
    await tool("ticket_update_status", { ticketId, status: "blocked" });
    stack.posted.length = 0;

    const prompt = stack.prompts.at(-1)!;
    const answer = fakePromptClick(
      { ...ada, threadId: prompt.target.threadId! },
      prompt.components,
      0,
    )!;
    await answerPromptClick(
      answer,
      { defer: async () => {}, close: async () => {}, whisper: async () => {} },
      { coordinator: stack.coordinator, fetcher: fetch },
    );

    expect(stack.posted).toEqual([
      { target: { channelId: CHANNEL, threadId: THREAD }, content: TICKET_RESUMED_MESSAGE },
    ]);
    const [resumed] = await tickets();
    expect(resumed).toMatchObject({ id: ticketId, status: "assigned", workerId: WORKER });
    expect((await events(ticketId)).map((e) => [e.type, e.body])).toEqual(
      expect.arrayContaining([
        ["follow_up", 'Answer to "Deploy to production now?": Approve'],
        ["system", "Resumed by a follow-up (was blocked)"],
      ]),
    );
  });

  it("an answer while the Worker is still running only records the answer", async () => {
    const ticketId = await startTicket("deploy the new pricing page");
    await tool("ticket_ask", { ticketId, kind: "approval", question: "Deploy now?" });
    const prompt = stack.prompts.at(-1)!;
    const answer = fakePromptClick(
      { ...ada, threadId: prompt.target.threadId! },
      prompt.components,
      0,
    )!;
    await answerPromptClick(
      answer,
      { defer: async () => {}, close: async () => {}, whisper: async () => {} },
      { coordinator: stack.coordinator, fetcher: fetch },
    );
    const [ticket] = await tickets();
    expect(ticket).toMatchObject({ status: "in_progress", workerId: WORKER });
  });
});
