import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// The dashboard's live system map reads GET /activity. A Discord message, an MCP worker's
// claim and completion must all show up there, in order, with the sender's identity.

/** The shared worker an admin registered; set once the stack is up. */
let WORKER: string;
let SECRET: string;
const CHANNEL = "chan-1";
const speaker: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada" };

let stack: Stack;
let mcp: Awaited<ReturnType<Stack["worker"]>>;

beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request") });
  ({ workerId: WORKER, secret: SECRET } = await stack.registerSharedWorker());
  mcp = await stack.worker(SECRET);
});
afterEach(() => stack.stop());

const tool = (name: string, args: Record<string, unknown>) =>
  mcp.callTool({ name, arguments: args });

describe("system map activity feed", () => {
  it("follows a Discord message through the Coordinator to a worker and back", async () => {
    await stack.linkChannel(CHANNEL);
    const baseline = await stack.json("GET", "/activity");
    expect(baseline.tickets).toEqual([]);

    await forwardInbound(stack.coordinator, fakeInbound(speaker, "please add dark mode")!, fetch);
    const created = await stack.json("GET", `/activity?since=${encodeURIComponent(baseline.now)}`);
    expect(created.tickets).toMatchObject([
      {
        status: "assigned",
        workerId: WORKER,
        origin: { channelType: "discord", sender: { id: "u1", name: "Ada" } },
        replyChannel: "discord",
      },
    ]);
    expect(created.events.map((e: { type: string }) => e.type)).toEqual(["created", "assigned"]);

    const ticketId = created.tickets[0].id as string;
    await tool("worker_heartbeat", { workerId: WORKER, workerType: "local", ticketId });
    await tool("ticket_claim", { ticketId, workerId: WORKER });
    await tool("ticket_append_event", {
      ticketId,
      type: "status_update",
      actor: "worker",
      actorId: WORKER,
      body: "halfway",
    });
    await tool("ticket_update_status", { ticketId, status: "completed" });

    const done = await stack.json("GET", `/activity?since=${encodeURIComponent(created.now)}`);
    expect(done.tickets).toMatchObject([{ id: ticketId, status: "completed" }]);
    expect(done.tickets[0].startedAt).not.toBeNull();
    expect(
      done.events.map((e: { type: string; actor: string }) => [e.type, e.actor]),
    ).toContainEqual(["status_update", "worker"]);
    expect(done.workers).toMatchObject([{ id: WORKER, status: "online" }]);
    // The ticket's thread-opened note, then the result in that thread.
    expect(stack.posted).toHaveLength(2);
  });
});
