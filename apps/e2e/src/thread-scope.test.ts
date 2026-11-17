import { IntentClassifier, newTicketLinkMessage, SCOPE_PROMPT_QUESTION } from "@project-os/core";
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

// A message in a finished ticket's thread is classified with that ticket as context. Clearly
// different work asks "New ticket or part of this one?" with buttons; "New ticket" opens it in
// a new thread of its own and links it back in the old one.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada" };
const inThread = (threadId: string): FakeSpeaker => ({ ...ada, threadId });

// The first message is a new request; anything said in a thread after that is other work.
const classifier = Layer.succeed(IntentClassifier, {
  classify: ({ ticketContext }) =>
    Effect.succeed(
      ticketContext === undefined
        ? { intent: "new_request", confidence: 1 }
        : ticketContext.includes("Last result: Dark mode shipped")
          ? {
              intent: "new_request",
              confidence: 1,
              scope: { choice: "out_of_scope" as const, confidence: 1 },
            }
          : { intent: "chit_chat", confidence: 1 },
    ),
});

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;
let WORKER: string;
let projectId: string;

beforeEach(async () => {
  stack = await startStack({ classifier });
  const registered = await stack.registerSharedWorker();
  WORKER = registered.workerId;
  mcp = await stack.worker(registered.secret);
  projectId = await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string) => {
  const inbound = fakeInbound(who, content);
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};
const tool = async (name: string, args: Record<string, unknown>) =>
  ((await mcp.callTool({ name, arguments: args })) as { structuredContent?: any })
    .structuredContent;
const tickets = () =>
  stack.json("GET", `/projects/${projectId}/tickets`) as Promise<
    Array<{ id: string; title: string; status: string }>
  >;

const click = async (choice: number) => {
  const prompt = stack.prompts.at(-1)!;
  const answer = fakePromptClick(
    { ...ada, threadId: prompt.target.threadId! },
    prompt.components,
    choice,
  );
  if (!answer) throw new Error(`no option ${choice}`);
  await answerPromptClick(
    answer,
    { defer: async () => {}, close: async () => {}, whisper: async () => {} },
    { coordinator: stack.coordinator, fetcher: fetch },
  );
};

/** Ada's dark-mode ticket, worked and finished by the shared Worker. */
const finishedTicket = async () => {
  await say(ada, "please add dark mode");
  const [ticket] = await tickets();
  await tool("ticket_claim", { ticketId: ticket!.id, workerId: WORKER });
  await tool("ticket_append_event", {
    ticketId: ticket!.id,
    type: "result",
    actor: "worker",
    body: "Dark mode shipped",
  });
  await tool("ticket_update_status", { ticketId: ticket!.id, status: "completed" });
  return ticket!;
};

describe("thread scope", () => {
  it("asks about other work in a finished ticket's thread, and opens a linked ticket on “New ticket”", async () => {
    const dark = await finishedTicket();

    await say(inThread("discord-thread-1"), "build a billing page");
    expect(stack.prompts.at(-1)).toMatchObject({
      target: { channelId: CHANNEL, threadId: "discord-thread-1" },
      content: expect.stringContaining(SCOPE_PROMPT_QUESTION),
    });
    expect(await tickets()).toHaveLength(1);

    await click(0);
    const all = await tickets();
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.id === dark.id)!.status).toBe("completed");
    expect(all.find((t) => t.id !== dark.id)).toMatchObject({
      title: "build a billing page",
      status: "assigned",
    });
    // A new thread in the channel (no starter message), linked from the old thread.
    expect(stack.createdThreads.at(-1)).toEqual({
      channelId: CHANNEL,
      name: "build a billing page",
    });
    expect(stack.posted.at(-1)).toEqual({
      target: { channelId: CHANNEL, threadId: "discord-thread-1" },
      content: newTicketLinkMessage("discord-thread-2"),
    });
  });

  it("keeps it on the finished ticket, reopening it, on “Part of this ticket”", async () => {
    const dark = await finishedTicket();
    await say(inThread("discord-thread-1"), "build a billing page");
    await click(1);
    const all = await tickets();
    expect(all).toEqual([expect.objectContaining({ id: dark.id, status: "assigned" })]);
  });
});
