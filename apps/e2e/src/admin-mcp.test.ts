import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { classifierReturning } from "@project-os/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// The admin MCP: read-only views of the dashboard's data for an admin's Claude, behind one static
// token. It sees what Discord → Ticket → Worker produced, masks anything credential-shaped, and
// refuses every other credential.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada", guildId: "guild-1" };
const TOKEN = "admin-mcp-token-admin-mcp-token-0123";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let stack: Stack;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await stack.stop();
});

const connect = async (token = TOKEN) => {
  const client = new Client({ name: "admin", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp/admin`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
};

const read = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: any;
    content: { text: string }[];
  };

describe("admin MCP", () => {
  it("reads tickets, events, workers, audit and members, with secrets masked", async () => {
    stack = await startStack({
      classifier: classifierReturning("new_request"),
      adminMcpToken: TOKEN,
    });
    const { workerId, mcp } = await stack.registerSharedWorker("box");
    const projectId = await stack.linkChannel(CHANNEL);
    await forwardInbound(
      stack.coordinator,
      fakeInbound(ada, "please add dark mode", { id: "m1", mention: true })!,
      fetch,
    );
    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    await mcp.callTool({ name: "ticket_claim", arguments: { ticketId: ticket.id, workerId } });
    const appended = await mcp.callTool({
      name: "ticket_append_event",
      arguments: {
        ticketId: ticket.id,
        type: "comment",
        actor: "worker",
        actorId: workerId,
        body: `gh auth with ${GITHUB_TOKEN}, then ${TOKEN} and the service token ${stack.coordinator.token}`,
      },
    });
    expect(appended.isError).toBeFalsy();

    const admin = await connect();
    const { tools } = await admin.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "get_project",
      "get_project_memory",
      "get_ticket",
      "get_ticket_run",
      "get_worker",
      "list_activity",
      "list_members",
      "list_projects",
      "list_ticket_runs",
      "list_tickets",
      "list_workers",
      "query_audit",
    ]);

    const tickets = await read(admin, "list_tickets", { projectId, status: "in_progress" });
    expect(tickets.structuredContent.tickets).toMatchObject([{ id: ticket.id, workerId }]);
    expect(
      (await read(admin, "get_project", { projectId })).structuredContent.sources,
    ).toHaveLength(1);
    expect((await read(admin, "list_workers")).structuredContent.workers).toMatchObject([
      { id: workerId, status: "online" },
    ]);
    expect((await read(admin, "get_worker", { workerId })).structuredContent.tickets).toHaveLength(
      1,
    );
    const audit = await read(admin, "query_audit", { workerId });
    expect(audit.structuredContent.entries.length).toBeGreaterThan(0);
    expect((await read(admin, "list_members")).structuredContent.members.length).toBeGreaterThan(0);
    expect((await read(admin, "list_activity")).isError).toBeFalsy();
    expect(
      (await read(admin, "list_ticket_runs", { ticketId: ticket.id })).structuredContent.runs,
    ).toEqual([]);

    // The event the worker wrote carried a GitHub token and two secrets the Coordinator knows.
    const detail = await read(admin, "get_ticket", { ticketId: ticket.id });
    const everything = JSON.stringify([
      detail.structuredContent,
      tickets.structuredContent,
      audit.structuredContent,
    ]);
    expect(everything).toContain("[REDACTED]");
    expect(everything).not.toContain(GITHUB_TOKEN);
    expect(everything).not.toContain(stack.coordinator.token);
    expect(everything).not.toContain(TOKEN);
  });

  it("pages a run's transcript and masks what a session printed", async () => {
    stack = await startStack({
      classifier: classifierReturning("new_request"),
      adminMcpToken: TOKEN,
    });
    const projectId = await stack.linkChannel(CHANNEL);
    await forwardInbound(
      stack.coordinator,
      fakeInbound(ada, "please add dark mode", { id: "m1", mention: true })!,
      fetch,
    );
    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    const output = [
      ...Array.from({ length: 249 }, (_, i) => `line ${i}`),
      `leaked ${GITHUB_TOKEN}`,
    ].join("\n");
    await stack.recordSandboxRun({
      ticketId: ticket.id,
      workerId: "daytona-1",
      agent: "pi",
      model: "m",
      startedAt: "2026-11-24T00:00:00.000Z",
      exitCode: 1,
      output,
      secrets: [],
    });

    const admin = await connect();
    const { runs } = (await read(admin, "list_ticket_runs", { ticketId: ticket.id }))
      .structuredContent;
    expect(runs).toMatchObject([{ agent: "pi", status: "failed" }]);
    const first = (await read(admin, "get_ticket_run", { ticketId: ticket.id, runId: runs[0].id }))
      .structuredContent;
    expect(first.events).toHaveLength(200);
    expect(first).toMatchObject({ total: 251, nextOffset: 200 });
    const second = (
      await read(admin, "get_ticket_run", { ticketId: ticket.id, runId: runs[0].id, offset: 200 })
    ).structuredContent;
    expect(second.events).toHaveLength(51);
    expect(second.nextOffset).toBeNull();
    expect(JSON.stringify(second)).not.toContain(GITHUB_TOKEN);
  });

  it("returns a tool failure for an unknown ticket and refuses a bad since", async () => {
    stack = await startStack({
      classifier: classifierReturning("new_request"),
      adminMcpToken: TOKEN,
    });
    const admin = await connect();
    expect((await read(admin, "get_ticket", { ticketId: "nope" })).isError).toBe(true);
    expect((await read(admin, "list_activity", { since: "yesterday-ish" })).isError).toBe(true);
  });

  it("refuses every credential but its own token", async () => {
    stack = await startStack({
      classifier: classifierReturning("new_request"),
      adminMcpToken: TOKEN,
    });
    const { secret } = await stack.registerSharedWorker("box");
    const post = (token?: string) =>
      fetch(`${stack.url}/mcp/admin`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post()).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    expect((await post(secret)).status).toBe(401);
    expect((await post(stack.operatorToken)).status).toBe(401);
    expect((await post(stack.coordinator.token)).status).toBe(401);
    expect((await post(TOKEN)).status).toBe(200);
    // And the admin token is no Worker credential.
    const asWorker = await fetch(`${stack.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(asWorker.status).toBe(401);
  });

  it("is not mounted without a token", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    const res = await fetch(`${stack.url}/mcp/admin`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
