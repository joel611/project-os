import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { schema } from "@project-os/db-sqlite";
import { LocalLive, openLocalDb } from "@project-os/infra-local";
import { ProjectRepository, TicketRepository } from "@project-os/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { mcpRoutes } from "./server.ts";
import { toFailure } from "./tools.ts";

const T0 = "2026-11-04T00:00:00.000Z";
let dir: string;
let runtime: ManagedRuntime.ManagedRuntime<any, never>;
let client: Client;

const seed = Effect.gen(function* () {
  yield* (yield* ProjectRepository).insert({
    id: "p1",
    orgId: "o1",
    name: "P",
    slug: null,
    customInstructions: "",
    defaultResponseChannelId: null,
    status: "active",
    createdBy: null,
    createdAt: T0,
    updatedAt: T0,
  });
  const tickets = yield* TicketRepository;
  yield* tickets.insert({
    id: "t1",
    projectId: "p1",
    status: "open",
    title: "x",
    intent: null,
    inputSummary: "x",
    priority: null,
    workerType: "local_claude",
    workerId: null,
    result: null,
    error: null,
    createdAt: T0,
    assignedAt: null,
    startedAt: null,
    lastActivityAt: T0,
    completedAt: null,
    updatedAt: T0,
  });
  yield* tickets.assign("t1", { workerType: "local_claude", workerId: "w1" }, T0);
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-"));
  const dbPath = join(dir, "test.sqlite");
  const { sqlite, db } = openLocalDb(dbPath);
  db.insert(schema.orgs).values({ id: "o1", name: "Org", createdAt: T0 }).run();
  sqlite.close();

  const layer = LocalLive({ dbPath, adapterUrls: {} });
  runtime = ManagedRuntime.make(layer as Layer.Layer<any, never>);
  await runtime.runPromise(seed as Effect.Effect<void, never, any>);

  const app = new Elysia().use(mcpRoutes(runtime));
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => app.handle(new Request(url.toString(), init)),
    }),
  );
});

afterEach(async () => {
  await client.close();
  await runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return res as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
};

describe("coordinator MCP server", () => {
  it("lists the ten worker tools with JSON input schemas and no channel tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "project_memory_read",
      "project_memory_write",
      "project_sources_list",
      "ticket_append_event",
      "ticket_claim",
      "ticket_get",
      "ticket_list_assigned",
      "ticket_update_status",
      "user_token",
      "worker_heartbeat",
    ]);
    const claim = tools.find((t) => t.name === "ticket_claim")!;
    expect(claim.inputSchema.required).toEqual(["ticketId", "workerId"]);
  });

  it("runs claim -> append -> complete against infra-local", async () => {
    const listed = await call("ticket_list_assigned", { workerId: "w1" });
    expect(listed.structuredContent.tickets.map((t: any) => t.id)).toEqual(["t1"]);

    const claimed = await call("ticket_claim", { ticketId: "t1", workerId: "w1" });
    expect(claimed.structuredContent.ticket.status).toBe("in_progress");

    const appended = await call("ticket_append_event", {
      ticketId: "t1",
      type: "comment",
      actor: "worker",
      actorId: "w1",
      body: "working on it",
    });
    expect(appended.structuredContent.event.body).toBe("working on it");

    const done = await call("ticket_update_status", { ticketId: "t1", status: "completed" });
    expect(done.structuredContent.ticket.status).toBe("completed");

    const got = await call("ticket_get", { ticketId: "t1" });
    expect(got.structuredContent.ticket.status).toBe("completed");
    expect(got.structuredContent.events.map((e: any) => e.body)).toContain("working on it");
  });

  it("writes and reads project memory and records heartbeats", async () => {
    const written = await call("project_memory_write", {
      projectId: "p1",
      ticketId: "t1",
      type: "note",
      title: "Learned",
      content: "use bun",
    });
    expect(written.isError).toBeFalsy();
    const read = await call("project_memory_read", { projectId: "p1" });
    expect(read.structuredContent.entries.map((e: any) => e.title)).toEqual(["Learned"]);

    const beat = await call("worker_heartbeat", { workerId: "w1", workerType: "local_claude" });
    expect(typeof beat.structuredContent.lastSeenAt).toBe("string");
  });

  it("returns typed failures as isError results", async () => {
    await call("ticket_claim", { ticketId: "t1", workerId: "w1" });
    const again = await call("ticket_claim", { ticketId: "t1", workerId: "w2" });
    expect(again.isError).toBe(true);
    expect(JSON.parse(again.content[0]!.text)._tag).toBe("ClaimConflict");

    const missing = await call("ticket_get", { ticketId: "nope" });
    expect(JSON.parse(missing.content[0]!.text)._tag).toBe("TicketNotFound");
  });

  it("maps untagged errors to a generic failure", () => {
    expect(toFailure("boom")).toEqual({ _tag: "Error", message: "boom" });
  });

  it("rejects invalid input and unknown tools", async () => {
    const bad = await call("ticket_claim", { ticketId: "" });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0]!.text)._tag).toBe("InvalidInput");

    const noArgs = (await client.callTool({ name: "ticket_claim" })) as { isError?: boolean };
    expect(noArgs.isError).toBe(true);

    const unknown = await call("channel_send", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("UnknownTool");
  });
});
