import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@project-os/db-sqlite";
import { LocalLive, openLocalDb } from "@project-os/infra-local";
import { ProjectRepository, TicketRepository } from "@project-os/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ADMIN_LIST_LIMIT, makeAdminTools, redactDeep } from "./admin-tools.ts";

const T0 = "2026-11-04T00:00:00.000Z";
let dir: string;
let runtime: ManagedRuntime.ManagedRuntime<any, never>;

const ticket = (id: string, projectId: string, status: "open" | "completed", at: string) => ({
  id,
  projectId,
  status,
  title: id,
  intent: null,
  inputSummary: id,
  priority: null,
  workerType: "local" as const,
  workerId: null,
  requester: null,
  result: null,
  error: null,
  createdAt: at,
  assignedAt: null,
  startedAt: null,
  lastActivityAt: at,
  completedAt: null,
  updatedAt: at,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "admin-tools-"));
  const dbPath = join(dir, "test.sqlite");
  const { sqlite, db } = openLocalDb(dbPath);
  db.insert(schema.orgs).values({ id: "o1", name: "Org", createdAt: T0 }).run();
  sqlite.close();
  runtime = ManagedRuntime.make(LocalLive({ dbPath, adapterUrls: {} }) as Layer.Layer<any, never>);
  await runtime.runPromise(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      for (const id of ["p1", "p2"]) {
        yield* projects.insert({
          id,
          orgId: "o1",
          name: id,
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
      }
      const tickets = yield* TicketRepository;
      yield* tickets.insert(ticket("t1", "p1", "open", "2026-11-04T01:00:00.000Z"));
      yield* tickets.insert(ticket("t2", "p1", "completed", "2026-11-04T03:00:00.000Z"));
      yield* tickets.insert(ticket("t3", "p2", "open", "2026-11-04T02:00:00.000Z"));
    }) as Effect.Effect<void, never, any>,
  );
});

afterEach(async () => {
  await runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const tools = (extra: Partial<Parameters<typeof makeAdminTools>[0]> = {}) =>
  makeAdminTools({ workerStaleMs: 60_000, secrets: ["super-secret-value"], ...extra });

const call = async (name: string, args: unknown = {}, extra = {}) => {
  const tool = tools(extra).find((t) => t.name === name)!;
  return (await runtime.runPromise(tool.call(args) as Effect.Effect<any, any, any>)) as any;
};

describe("redactDeep", () => {
  it("masks secrets in nested strings and leaves other values alone", () => {
    const out = redactDeep(
      { a: ["token=abcdef123456", 1, null, true], b: { c: "keep super-secret-value" } },
      ["super-secret-value"],
    );
    expect(out).toEqual({ a: ["token=[REDACTED]", 1, null, true], b: { c: "keep [REDACTED]" } });
  });
});

describe("admin tools", () => {
  it("offers list_members only when it can read members", () => {
    expect(tools().map((t) => t.name)).not.toContain("list_members");
    const members = [{ key: "k", name: "Ada" }] as any;
    expect(tools({ members: async () => members }).map((t) => t.name)).toContain("list_members");
  });

  it("lists tickets newest activity first, narrowed by project and status", async () => {
    const all = await call("list_tickets");
    expect(all.tickets.map((t: { id: string }) => t.id)).toEqual(["t2", "t3", "t1"]);
    expect(all).toMatchObject({ total: 3, truncated: false });
    const open = await call("list_tickets", { projectId: "p1", status: "open" });
    expect(open.tickets.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    const capped = await call("list_tickets", { limit: 1 });
    expect(capped).toMatchObject({ total: 3, truncated: true });
    expect(capped.tickets).toHaveLength(1);
    expect(ADMIN_LIST_LIMIT).toBe(200);
  });

  it("reads projects, a ticket, workers, audit and activity", async () => {
    expect((await call("list_projects")).projects).toHaveLength(2);
    expect((await call("get_project", { projectId: "p1" })).project.id).toBe("p1");
    expect((await call("get_project_memory", { projectId: "p1" })).entries).toEqual([]);
    expect((await call("get_ticket", { ticketId: "t1" })).ticket.id).toBe("t1");
    expect((await call("list_ticket_runs", { ticketId: "t1" })).runs).toEqual([]);
    expect((await call("list_workers")).workers).toEqual([]);
    expect((await call("query_audit", { projectId: "p1" })).entries).toEqual([]);
    expect(await call("list_activity")).toBeTypeOf("object");
    expect(await call("list_activity", { since: T0 })).toBeTypeOf("object");
    expect(await call("list_members", {}, { members: async () => [{ key: "k" }] })).toEqual({
      members: [{ key: "k" }],
    });
  });

  it("fails for unknown things and a bad since, as typed tool failures", async () => {
    await expect(call("get_ticket", { ticketId: "nope" })).rejects.toMatchObject({
      _tag: "TicketNotFound",
    });
    await expect(call("get_worker", { workerId: "nope" })).rejects.toMatchObject({
      _tag: "WorkerNotFound",
    });
    await expect(call("get_ticket_run", { ticketId: "t1", runId: "nope" })).rejects.toMatchObject({
      _tag: "RunNotFound",
    });
    await expect(call("list_activity", { since: "later" })).rejects.toMatchObject({
      _tag: "InvalidInput",
    });
    await expect(call("get_project", {})).rejects.toMatchObject({ _tag: "InvalidInput" });
  });

  it("masks secrets in what a tool returns", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).appendEvent({
          id: "e1",
          ticketId: "t1",
          type: "comment",
          actor: "worker",
          actorId: null,
          body: "key super-secret-value and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          payload: null,
          createdAt: T0,
        });
      }) as Effect.Effect<void, never, any>,
    );
    const { events } = await call("get_ticket", { ticketId: "t1" });
    expect(JSON.stringify(events)).not.toMatch(/super-secret-value|ghp_/);
    expect(JSON.stringify(events)).toContain("[REDACTED]");
  });
});
