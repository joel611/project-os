import { classifierReturning } from "@project-os/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// The dashboard's worker detail page: one Worker with its status, the Tickets assigned to it,
// and its own slice of the audit log.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada", guildId: "guild-1" };

let stack: Stack;
afterEach(() => stack.stop());

describe("worker detail", () => {
  it("shows a worker's status, its tickets and its audit entries", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    const { workerId, mcp } = await stack.registerSharedWorker("box");
    const projectId = await stack.linkChannel(CHANNEL);
    await forwardInbound(
      stack.coordinator,
      fakeInbound(ada, "please add dark mode", { id: "m1", mention: true })!,
      fetch,
    );

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket.workerId).toBe(workerId);
    await mcp.callTool({ name: "ticket_claim", arguments: { ticketId: ticket.id, workerId } });
    const other = await stack.registerSharedWorker("other-box");

    const detail = await stack.json("GET", `/workers/${workerId}`);
    expect(detail.worker).toMatchObject({ id: workerId, status: "online", registered: true });
    expect(detail.tickets).toMatchObject([{ id: ticket.id, status: "in_progress" }]);
    expect((await stack.json("GET", `/workers/${other.workerId}`)).tickets).toEqual([]);

    const feed = await stack.json("GET", `/workers/${workerId}/audit`);
    expect(feed.entries.every((e: { workerId: string }) => e.workerId === workerId)).toBe(true);
    const lines = feed.entries.map(
      (e: { kind: string; action: string }) => `${e.kind}/${e.action}`,
    );
    expect(lines).toEqual(expect.arrayContaining(["worker/registered", "ticket/assigned"]));
  });

  it("404s an unknown worker and needs a dashboard user", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    const call = (path: string, token?: string) =>
      fetch(`${stack.url}${path}`, {
        ...(token && { headers: { authorization: `Bearer ${token}` } }),
      });
    expect((await call("/workers/nope", stack.operatorToken)).status).toBe(404);
    expect((await call("/workers/nope/audit", stack.operatorToken)).status).toBe(404);
    expect((await call("/workers/nope/audit?kind=nope", stack.operatorToken)).status).toBe(400);
    expect((await call("/workers/nope")).status).toBe(401);
  });
});
