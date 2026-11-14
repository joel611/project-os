import { classifierReturning } from "@project-os/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { ADMIN_CHANNEL, ADMIN_USER, type Stack, startStack } from "./stack.ts";

// The dashboard's Audit page (org-wide) and a project's Audit tab: what arrived from Discord,
// what the Channel Digest did, and how Workers and Tickets changed, newest first. Rows with no
// project (admin channel, unlinked channels, Workers) show only org-wide.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada", guildId: "guild-1" };

interface Entry {
  kind: string;
  action: string;
  actorType: string;
  actorName: string | null;
  projectId: string | null;
  summary: string;
  payload: any;
}
interface Page {
  entries: Entry[];
  nextCursor: string | null;
}

let stack: Stack;
afterEach(() => stack.stop());

const send = (
  speaker: FakeSpeaker,
  content: string,
  options: { id: string; mention: boolean; at?: Date },
) => forwardInbound(stack.coordinator, fakeInbound(speaker, content, options)!, fetch);

describe("audit log", () => {
  it("records inbound messages, digest runs, workers and tickets, org-wide and per project", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    const { workerId, mcp } = await stack.registerSharedWorker("box");
    const projectId = await stack.linkChannel(CHANNEL);

    const earlier = new Date(Date.now() - 60 * 60_000);
    await send(ada, "ok we decided: SQLite <@999>", { id: "m1", mention: false, at: earlier });
    await send(ada, "please add dark mode", { id: "m2", mention: true });
    await send({ ...ada, channelId: "unlinked" }, "elsewhere", { id: "m3", mention: false });
    await send({ ...ada, channelId: ADMIN_CHANNEL, userId: ADMIN_USER }, "list projects", {
      id: "m4",
      mention: false,
    });

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({ status: "assigned", workerId });
    await mcp.callTool({ name: "ticket_claim", arguments: { ticketId: ticket.id, workerId } });
    await mcp.callTool({
      name: "ticket_update_status",
      arguments: { ticketId: ticket.id, status: "completed" },
    });
    await stack.runDigest({ quietMs: 0 });

    const org = (await stack.json("GET", "/audit")) as Page;
    const line = (e: Entry) => `${e.kind}/${e.action}${e.projectId ? " (project)" : ""}`;
    expect(org.entries.map(line).reverse()).toEqual([
      "worker/registered",
      "worker/first_seen",
      "inbound_event/received (project)",
      "inbound_event/received (project)",
      "ticket/created (project)",
      "ticket/assigned (project)",
      "inbound_event/received",
      "inbound_event/received",
      "ticket/claimed (project)",
      "ticket/status_changed (project)",
      "digest_event/digested (project)",
    ]);
    const first = org.entries.find((e) => e.payload?.externalId === "m1")!;
    expect(first).toMatchObject({ actorName: "Ada", summary: "ok we decided: SQLite" });
    expect(org.entries.find((e) => e.payload?.externalId === "m4")!.payload.admin).toBe(true);

    const project = (await stack.json("GET", `/projects/${projectId}/audit`)) as Page;
    expect(project.entries.every((e) => e.projectId === projectId)).toBe(true);
    expect(project.entries).toHaveLength(7);

    const tickets = (await stack.json(
      "GET",
      `/projects/${projectId}/audit?kind=ticket&limit=2`,
    )) as Page;
    expect(tickets.entries.map((e) => e.action)).toEqual(["status_changed", "claimed"]);
    const older = (await stack.json(
      "GET",
      `/projects/${projectId}/audit?kind=ticket&limit=2&before=${tickets.nextCursor}`,
    )) as Page;
    expect(older.entries.map((e) => e.action)).toEqual(["assigned", "created"]);

    const workers = (await stack.json("GET", `/audit?kind=worker&projectId=${projectId}`)) as Page;
    expect(workers.entries).toEqual([]);
  });

  it("refuses a bad kind or limit, and an unknown project", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    const call = (path: string) =>
      fetch(`${stack.url}${path}`, { headers: { authorization: `Bearer ${stack.operatorToken}` } });
    expect((await call("/audit?kind=nope")).status).toBe(400);
    expect((await call("/audit?limit=0")).status).toBe(400);
    expect((await call("/projects/nope/audit?kind=nope")).status).toBe(400);
    expect((await call("/projects/nope/audit")).status).toBe(404);
    expect((await call("/audit?projectId=nope")).status).toBe(404);
  });
});
