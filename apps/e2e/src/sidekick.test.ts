import { IntentClassifier, THREAD_OPENED_MESSAGE, TICKET_CLOSED_MESSAGE } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import {
  fakeCommand,
  fakeInbound,
  type FakeSpeaker,
} from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A tool-only request (list Drive, read a repo's status) never reaches a Worker: the
// Coordinator hands it to the Sidekick, which answers in the ticket's thread as the person who
// asked. A request that needs the repo, tests or a script still waits for a Worker to pull it.

/** The shared worker an admin registered; set once the stack is up. */
let WORKER: string;
let SECRET: string;
const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };

// Reads the executor off the message, so one stack can see both kinds of request.
const classifier = Layer.succeed(IntentClassifier, {
  classify: ({ content }) =>
    Effect.succeed({
      intent: "new_request",
      confidence: 1,
      executor: content.startsWith("lookup") ? ("sidekick" as const) : ("worker" as const),
    }),
});

let stack: Stack;
let projectId: string;

beforeEach(async () => {
  stack = await startStack({ classifier, connections: true });
  ({ workerId: WORKER, secret: SECRET } = await stack.registerSharedWorker());
  projectId = await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string, id?: string) => {
  const inbound = fakeInbound(who, content, id ? { id } : {});
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};
const tickets = (): Promise<
  Array<{ id: string; title: string; status: string; workerType: string; workerId: string }>
> => stack.json("GET", `/projects/${projectId}/tickets`);
// Read as the dashboard does: a Sidekick ticket isn't the shared worker's to see.
const events = async (ticketId: string): Promise<Array<{ type: string; body: string }>> =>
  (await stack.json("GET", `/tickets/${ticketId}`)).events;
const assignedToWorker = async () => {
  const mcp = await stack.worker(SECRET);
  const out = (await mcp.callTool({
    name: "ticket_list_assigned",
    arguments: { workerId: WORKER, workerType: "local" },
  })) as unknown as { structuredContent: { tickets: unknown[] } };
  return out.structuredContent.tickets;
};
const connect = async (who: FakeSpeaker, provider: string) => {
  const reply = await forwardCommand(
    stack.coordinator,
    fakeCommand(who, "connect", { provider })!,
    fetch,
  );
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)?.[1];
  expect(link, reply.content).toBeDefined();
  expect((await browse(link!, undefined, "POST")).status).toBe(200);
};

describe("Sidekick", () => {
  it("answers a lookup in a new thread and leaves nothing for a Worker", async () => {
    await say(ada, "lookup the latest release of acme/web", "msg-1");

    const [ticket] = await tickets();
    expect(ticket).toMatchObject({
      status: "completed",
      workerType: "sidekick",
      workerId: "sidekick",
    });
    expect((await events(ticket!.id)).map((e) => e.type)).toEqual([
      "created",
      "assigned",
      "result",
    ]);
    expect(stack.createdThreads).toHaveLength(1);
    expect(
      stack.posted.filter((p) => p.target.threadId === "discord-thread-1").map((p) => p.content),
    ).toEqual([
      THREAD_OPENED_MESSAGE,
      // Ada hasn't linked GitHub: the ask goes in the ticket's thread.
      expect.stringContaining("<@u-ada>, I need your GitHub access"),
      "sidekick: lookup the latest release of acme/web",
    ]);
    expect(await assignedToWorker()).toEqual([]);
  });

  it("still makes a Worker pull a request that needs the repo, tests or a script", async () => {
    await say(ada, "run the tests on acme/web");

    const [ticket] = await tickets();
    expect(ticket).toMatchObject({ status: "assigned", workerId: WORKER });
    expect(await assignedToWorker()).toHaveLength(1);
    expect(stack.sidekickCalls).toEqual([]);
  });

  it("keeps a finished Sidekick ticket's thread open for follow-ups", async () => {
    await say(ada, "lookup the latest release of acme/web");
    await say({ ...ada, threadId: "discord-thread-1" }, "and the one before it?", "msg-2");

    const [ticket] = await tickets();
    expect(ticket!.status).toBe("completed");
    expect(stack.sidekickCalls.map((c) => c.prompt)).toEqual([
      "lookup the latest release of acme/web",
      "and the one before it?",
    ]);
    expect(stack.posted.at(-1)).toMatchObject({
      target: { threadId: "discord-thread-1" },
      content: "sidekick: and the one before it?",
    });
    expect(stack.posted.map((p) => p.content)).not.toContain(TICKET_CLOSED_MESSAGE);
  });

  it("asks an unlinked person to /connect, from the same place a Worker would", async () => {
    await say(ada, "lookup the latest release of acme/web");

    expect(stack.sidekickCalls[0]?.token).toMatchObject({ ok: false });
    expect(stack.posted.map((p) => p.content).join("\n")).toContain("/connect provider:github");
  });

  it("gives the Sidekick the token of the person who asked, not anyone else's", async () => {
    await connect(ada, "github");
    await say(ada, "lookup the latest release of acme/web");

    const token = stack.sidekickCalls[0]?.token;
    expect(token).toMatchObject({ ok: true });
    expect(token && token.ok && token.accessToken).toMatch(/^at-github-/);
    expect(stack.posted.map((p) => p.content).join("\n")).not.toContain("/connect provider:github");
  });
});
