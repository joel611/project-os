import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { schema } from "@project-os/db-sqlite";
import { LocalLive, openLocalDb } from "@project-os/infra-local";
import {
  issueSandboxToken,
  ProjectRepository,
  sha256Hex,
  TicketRepository,
  WorkerRepository,
} from "@project-os/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia } from "elysia";
import { z } from "zod";
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
    channelDigest: true,
    channelDigestNotify: false,
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
    workerType: "local",
    workerId: null,
    requester: null,
    result: null,
    error: null,
    createdAt: T0,
    assignedAt: null,
    startedAt: null,
    lastActivityAt: T0,
    completedAt: null,
    updatedAt: T0,
  });
  yield* tickets.assign("t1", { workerType: "local", workerId: "w1" }, T0);
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

  app = new Elysia().use(mcpRoutes(runtime));
  client = await connect(await mint("w1"));
});

let app: { handle: (request: Request) => Promise<Response> };
const clients: Client[] = [];

const mint = (workerId: string) =>
  runtime.runPromise(issueSandboxToken(workerId, 60) as Effect.Effect<string, never, any>);

const connect = async (token?: string) => {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => app.handle(new Request(url.toString(), init)),
      ...(token && { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    }),
  );
  clients.push(c);
  return c;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return res as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
};

describe("coordinator MCP server", () => {
  it("lists the fourteen worker tools with JSON input schemas and no channel tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "project_memory_read",
      "project_memory_write",
      "project_sources_list",
      "ticket_append_event",
      "ticket_ask",
      "ticket_attach_file",
      "ticket_attachments",
      "ticket_claim",
      "ticket_get",
      "ticket_get_prompt",
      "ticket_list_assigned",
      "ticket_update_status",
      "user_token",
      "worker_heartbeat",
    ]);
    const claim = tools.find((t) => t.name === "ticket_claim")!;
    expect(claim.inputSchema.required).toEqual(["ticketId", "workerId"]);
    const memory = tools.find((t) => t.name === "project_memory_write")!;
    expect(memory.description).toContain("one or two sentences with the durable outcome");
    expect(memory.description).toContain("Link to a PR, issue or document");
    expect(memory.description).toContain("on the ticket, not in memory");
  });

  it("hides user_token from sandbox sessions only while the credential proxy is on", async () => {
    app = new Elysia().use(mcpRoutes(runtime, { credentialProxy: true }));
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    expect(await names(await connect(await mint("w1")))).not.toContain("user_token");
    const sandbox = await connect(await mint("w1"));
    const refused = (await sandbox.callTool({
      name: "user_token",
      arguments: { ticketId: "t1", provider: "github" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("UnknownTool");

    // A Watcher device still gets it: it isn't launched with the proxy's env.
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* WorkerRepository).register({
          id: "w-box",
          workerType: "local",
          owner: null,
          name: "box",
          secretHash: yield* sha256Hex("box-secret"),
          at: T0,
        });
      }) as Effect.Effect<void, never, any>,
    );
    expect(await names(await connect("box-secret"))).toContain("user_token");
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

    const beat = await call("worker_heartbeat", { workerId: "w1", workerType: "local" });
    expect(typeof beat.structuredContent.lastSeenAt).toBe("string");
  });

  it("returns typed failures as isError results", async () => {
    await call("ticket_claim", { ticketId: "t1", workerId: "w1" });
    const again = await call("ticket_claim", { ticketId: "t1", workerId: "w1" });
    expect(again.isError).toBe(true);
    expect(JSON.parse(again.content[0]!.text)._tag).toBe("ClaimConflict");

    const missing = await call("ticket_get", { ticketId: "nope" });
    expect(JSON.parse(missing.content[0]!.text)._tag).toBe("TicketNotFound");
  });

  it("refuses a caller without a token or with an unknown one", async () => {
    await expect(connect()).rejects.toThrow(/Unauthorized/);
    await expect(connect("not-a-token")).rejects.toThrow(/Unauthorized/);
  });

  it("keeps a worker to its own id and its own tickets", async () => {
    const other = await connect(await mint("w2"));
    const asW1 = (await other.callTool({
      name: "ticket_list_assigned",
      arguments: { workerId: "w1" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(asW1.isError).toBe(true);
    expect(JSON.parse(asW1.content[0]!.text)._tag).toBe("WorkerUnauthorized");
    const ticket = (await other.callTool({
      name: "ticket_get",
      arguments: { ticketId: "t1" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(JSON.parse(ticket.content[0]!.text)._tag).toBe("WorkerUnauthorized");
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

describe("experimental built-in skills over MCP", () => {
  const withSkills = async () => {
    app = new Elysia().use(mcpRoutes(runtime, { experimentalSkills: true }));
    return await connect(await mint("w1"));
  };

  it("serves nothing skill-related unless the flag is on", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("skill_list");
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
  });

  it("offers skill_list and skill_read tools", async () => {
    const c = await withSkills();
    const listed = (await c.callTool({ name: "skill_list", arguments: {} })) as any;
    expect(listed.structuredContent.skills.map((s: any) => s.name)).toEqual([
      "project-os-tickets",
      "project-os-memory",
      "project-os-accounts",
    ]);
    const read = (await c.callTool({
      name: "skill_read",
      arguments: { name: "project-os-tickets" },
    })) as any;
    expect(read.structuredContent.content).toContain("ticket_claim");
    const missing = (await c.callTool({
      name: "skill_read",
      arguments: { name: "project-os-tickets", path: "nope.md" },
    })) as any;
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text)._tag).toBe("SkillNotFound");
  });

  it("serves skill:// resources and the SEP-2640 skills/list and skills/get methods", async () => {
    const c = await withSkills();
    expect(c.getServerCapabilities()?.resources).toBeDefined();
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain("skill://project-os-memory/SKILL.md");
    const read = await c.readResource({ uri: "skill://project-os-memory/SKILL.md" });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toContain("name: project-os-memory");

    const raw = (method: string, params: object) =>
      c.request({ method, params } as never, z.object({}).passthrough()) as Promise<any>;
    const list = await raw("skills/list", {});
    const entry = list.skills.find((e: any) => e.uri === "skill://project-os-memory/SKILL.md");
    expect(entry.frontmatter.name).toBe("project-os-memory");
    const bytes = new TextEncoder().encode(text);
    expect(entry.resources[0].size).toBe(bytes.length);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    expect(entry.resources[0].digest).toBe(
      `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    );
    const got = await raw("skills/get", { uri: "skill://project-os-memory/SKILL.md" });
    expect(got.uri).toBe(entry.uri);
    await expect(raw("skills/get", { uri: "skill://nope/SKILL.md" })).rejects.toThrow();
    await expect(c.readResource({ uri: "skill://nope/SKILL.md" })).rejects.toThrow();
  });
});
