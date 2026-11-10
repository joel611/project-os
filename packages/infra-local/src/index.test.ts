import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  claimTicketUseCase,
  Clock,
  IdGenerator,
  KeyValueStore,
  ProjectRepository,
  Scheduler,
  TicketRepository,
  updateStatus,
  WorkerLauncher,
} from "@project-os/core";
import { schema } from "@project-os/db-sqlite";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { LocalLive, openLocalDb } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infra-local-"));
  dbPath = join(dir, "test.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const live = () => LocalLive({ dbPath, adapterUrls: {} });

describe("LocalLive", () => {
  it("satisfies Clock, IdGenerator, KV, Scheduler and WorkerLauncher", async () => {
    const program = Effect.gen(function* () {
      const now = yield* (yield* Clock).now;
      const id = yield* (yield* IdGenerator).next;
      const kv = yield* KeyValueStore;
      yield* kv.set("k", "v");
      const stop = yield* (yield* Scheduler).every("t", 1000, Effect.void);
      yield* stop;
      yield* (yield* WorkerLauncher).launch({
        ticketId: "t",
        workerType: "local",
        workerId: "w",
        mcpToken: "m",
      });
      return { now, id, v: yield* kv.get("k") };
    });
    const out = await Effect.runPromise(program.pipe(Effect.provide(live())));
    expect(out.now).toBeInstanceOf(Date);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.v).toBe("v");
  });

  it("AgentRuntime is a defect until the runtime ticket wires it", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(AgentRuntime, (r) => r.respond({ sessionId: "s", prompt: "p" })).pipe(
        Effect.provide(live()),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("runs a create -> claim -> complete ticket round-trip on a temp SQLite file", async () => {
    // Pre-migrate and seed the org (FK target), then close; the Layer reopens the same file.
    const { sqlite, db } = openLocalDb(dbPath);
    db.insert(schema.orgs).values({ id: "o1", name: "Org", createdAt: T0 }).run();
    sqlite.close();

    const program = Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const tickets = yield* TicketRepository;
      yield* projects.insert({
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
      const claimed = yield* claimTicketUseCase({ ticketId: "t1", workerId: "w1" });
      const done = yield* updateStatus({ ticketId: "t1", status: "completed" });
      return { claimed: claimed.status, done: done.status };
    });

    const out = await Effect.runPromise(program.pipe(Effect.provide(live())));
    expect(out).toEqual({ claimed: "in_progress", done: "completed" });

    // Persisted across connections.
    const reopened = await Effect.runPromise(
      Effect.flatMap(TicketRepository, (r) => r.get("t1")).pipe(Effect.provide(live())),
    );
    expect(reopened.status).toBe("completed");
  });
});
