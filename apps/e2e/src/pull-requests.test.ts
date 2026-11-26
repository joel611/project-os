import { Database } from "bun:sqlite";
import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

const who = { channelId: "chan-1", userId: "u-ada", name: "Ada" };
const PR = "https://github.com/acme/web/pull/42";
let stack: Stack;
let worker: Awaited<ReturnType<Stack["registerSharedWorker"]>>;
let ticketId: string;
let state: { merged: boolean; state: string };
let status: number;
let calls: string[];

const tool = async (name: string, args: Record<string, unknown>) =>
  worker.mcp.callTool({ name, arguments: args });

beforeEach(async () => {
  state = { merged: false, state: "open" };
  status = 200;
  calls = [];
  stack = await startStack({
    classifier: Layer.succeed(IntentClassifier, {
      classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
    }),
    connections: true,
    githubFetch: (async (input, init) => {
      calls.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer .+/);
      return Response.json(state, { status });
    }) as typeof fetch,
  });
  worker = await stack.registerSharedWorker();
  const projectId = await stack.linkChannel(who.channelId);
  await forwardInbound(stack.coordinator, fakeInbound(who, "implement a feature")!, fetch);
  [{ id: ticketId }] = await stack.json("GET", `/projects/${projectId}/tickets`);
  await tool("ticket_claim", { ticketId, workerId: worker.workerId });
});
afterEach(() => stack.stop());

const connect = async () => {
  const reply = await forwardCommand(
    stack.coordinator,
    fakeCommand(who, "connect", { provider: "github" })!,
    fetch,
  );
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  expect((await browse(link, undefined, "POST")).status).toBe(200);
};
const finish = async (body = `Implemented: ${PR}. Also ${PR}/files`) => {
  await tool("ticket_append_event", { ticketId, type: "result", actor: "worker", body });
  await tool("ticket_update_status", { ticketId, status: "completed" });
  stack.posted.length = 0;
};

describe("PR merge notices", () => {
  it("polls open PRs, posts merged PRs in the original thread, and persists a receipt", async () => {
    await connect();
    await finish();
    await stack.checkPullRequests();
    expect(calls).toEqual(["https://api.github.com/repos/acme/web/pulls/42"]);
    expect(stack.posted).toEqual([]);
    state = { merged: true, state: "closed" };
    await Promise.all([stack.checkPullRequests(), stack.checkPullRequests()]);
    expect(stack.posted).toEqual([
      {
        target: { channelId: who.channelId, threadId: "discord-thread-1" },
        content: `PR merged: ${PR}`,
      },
    ]);
    const { events, ticket } = await stack.json("GET", `/tickets/${ticketId}`);
    expect(ticket.status).toBe("completed");
    expect(events.at(-1).payload).toEqual({ kind: "pull_request_settled", url: PR, merged: true });
    calls.length = 0;
    await stack.checkPullRequests();
    expect(calls).toEqual([]);
    expect(stack.posted).toHaveLength(1);
  });

  it("watches multiple result PRs independently, not links in comments", async () => {
    await connect();
    await tool("ticket_append_event", {
      ticketId,
      type: "comment",
      actor: "worker",
      body: "Background: https://github.com/acme/web/pull/99",
    });
    const second = "https://github.com/acme/api/pull/43";
    await finish(`Ready: ${PR} and ${second}/files`);
    state.merged = true;
    await stack.checkPullRequests();
    expect(calls).toEqual([
      "https://api.github.com/repos/acme/web/pulls/42",
      "https://api.github.com/repos/acme/api/pulls/43",
    ]);
    expect(stack.posted.map((post) => post.content)).toEqual([
      `PR merged: ${PR}`,
      `PR merged: ${second}`,
    ]);
    await stack.checkPullRequests();
    expect(stack.posted).toHaveLength(2);
  });

  it("does not treat closed-unmerged PRs or API failures as merges; retries later", async () => {
    await connect();
    await finish();
    state = { merged: false, state: "closed" };
    await stack.checkPullRequests();
    state.merged = true;
    for (const code of [403, 404, 429, 500]) {
      status = code;
      await stack.checkPullRequests();
    }
    expect(stack.posted).toEqual([]);
    status = 200;
    await stack.checkPullRequests();
    expect(stack.posted).toHaveLength(1);
  });

  it("does not fall back to the project channel when a legacy ticket has no thread", async () => {
    await connect();
    await finish();
    const db = new Database(stack.dbPath);
    try {
      db.run("DELETE FROM ticket_threads WHERE ticket_id = ?", [ticketId]);
    } finally {
      db.close();
    }
    state.merged = true;
    await stack.checkPullRequests();
    expect(calls).toEqual([]);
    expect(stack.posted).toEqual([]);
  });

  it("does not choose credentials when a legacy ticket has no human requester", async () => {
    await connect();
    await finish();
    const db = new Database(stack.dbPath);
    try {
      db.run("UPDATE ticket_events SET payload = NULL WHERE ticket_id = ? AND type = 'created'", [
        ticketId,
      ]);
    } finally {
      db.close();
    }
    state.merged = true;
    await stack.checkPullRequests();
    expect(calls).toEqual([]);
    expect(stack.posted).toEqual([]);
  });

  it("waits for completion and GitHub connection without nagging or changing ticket state", async () => {
    await tool("ticket_append_event", { ticketId, type: "result", actor: "worker", body: PR });
    await stack.checkPullRequests();
    expect(calls).toEqual([]);
    await finish();
    await stack.checkPullRequests();
    expect(calls).toEqual([]);
    expect(stack.posted).toEqual([]);
    await connect();
    state.merged = true;
    stack.posted.length = 0;
    await stack.checkPullRequests();
    expect(stack.posted).toHaveLength(1);
  });
});
