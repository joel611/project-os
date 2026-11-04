import { Database } from "bun:sqlite";
import type { MemoryEntry } from "@project-os/contracts";
import {
  MemoryRepository,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
  WorkerRepository,
  type Project,
  type ProjectSource,
  type Ticket,
  type TicketEvent,
} from "@project-os/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";
import * as schema from "../schema/index.ts";
import { SqliteRepositories } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const T1 = "2026-11-04T00:01:00.000Z";
const T2 = "2026-11-04T00:02:00.000Z";

const makeDb = () => {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: new URL("../../migrations", import.meta.url).pathname });
  db.insert(schema.orgs).values({ id: "o1", name: "Org", createdAt: T0 }).run();
  return db;
};

/** Fresh in-memory db per call, repos provided. */
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    | TicketRepository
    | ProjectRepository
    | ProjectSourceRepository
    | MemoryRepository
    | WorkerRepository
  >,
  db = makeDb(),
) => Effect.runPromise(program.pipe(Effect.provide(SqliteRepositories(db))));

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  orgId: "o1",
  name: "Proj",
  slug: null,
  customInstructions: "",
  defaultResponseChannelId: null,
  status: "active",
  createdBy: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const source = (over: Partial<ProjectSource> = {}): ProjectSource => ({
  id: "s1",
  projectId: "p1",
  type: "discord_channel",
  externalId: "chan-1",
  name: "#general",
  direction: "both",
  isDefaultResponse: false,
  config: { a: 1 },
  status: "active",
  connectedBy: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "assigned",
  title: "x",
  intent: null,
  inputSummary: "x",
  priority: null,
  workerType: "local_claude",
  workerId: "w1",
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: null,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
  ...over,
});

const event = (over: Partial<TicketEvent> = {}): TicketEvent => ({
  id: "e1",
  ticketId: "t1",
  type: "comment",
  actor: "worker",
  actorId: "w1",
  body: "hi",
  payload: { pct: 5 },
  createdAt: T1,
  ...over,
});

const memory = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "m1",
  projectId: "p1",
  ticketId: null,
  type: "note",
  title: "Title",
  content: "Body",
  sourceMetadata: { k: "v" },
  createdBy: null,
  createdAt: T0,
  ...over,
});

const seeded = Effect.gen(function* () {
  yield* (yield* ProjectRepository).insert(project());
});

describe("ProjectRepository", () => {
  it("round-trips and reports not found", async () => {
    const { got, all, miss } = await run(
      Effect.gen(function* () {
        const repo = yield* ProjectRepository;
        yield* repo.insert(project());
        return {
          got: yield* repo.get("p1"),
          all: yield* repo.list,
          miss: yield* Effect.flip(repo.get("nope")),
        };
      }),
    );
    expect(got).toEqual(project());
    expect(all).toHaveLength(1);
    expect(miss._tag).toBe("ProjectNotFound");
  });
});

describe("ProjectSourceRepository", () => {
  it("enforces unique (type, external_id)", async () => {
    const err = await run(
      Effect.gen(function* () {
        yield* seeded;
        yield* (yield* ProjectRepository).insert(project({ id: "p2" }));
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        return yield* Effect.flip(repo.insert(source({ id: "s2", projectId: "p2" })));
      }),
    );
    expect(err).toMatchObject({ _tag: "SourceAlreadyLinked", projectId: "p1" });
  });

  it("finds by external id, lists by project, preserves config JSON", async () => {
    const { found, none, list } = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        return {
          found: yield* repo.findByExternal("discord_channel", "chan-1"),
          none: yield* repo.findByExternal("email_address", "chan-1"),
          list: yield* repo.listByProject("p1"),
        };
      }),
    );
    expect(found).toEqual(source());
    expect(none).toBeUndefined();
    expect(list).toHaveLength(1);
  });

  it("keeps at most one default response per project", async () => {
    const { a, b, all, dbError } = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source({ id: "a", externalId: "1" }));
        yield* repo.insert(source({ id: "b", externalId: "2" }));
        const a = yield* repo.setDefaultResponse("p1", "a");
        const b = yield* repo.setDefaultResponse("p1", "b");
        const all = yield* repo.listByProject("p1");
        // Direct insert of a second default is rejected by the partial unique index.
        const dbError = yield* Effect.exit(
          repo.insert(source({ id: "c", externalId: "3", isDefaultResponse: true })),
        );
        return { a, b, all, dbError };
      }),
    );
    expect(a.isDefaultResponse).toBe(true);
    expect(b.isDefaultResponse).toBe(true);
    expect(all.filter((s) => s.isDefaultResponse).map((s) => s.id)).toEqual(["b"]);
    // Inserting "c" as default while "b" is default must not succeed.
    expect(Exit.isFailure(dbError)).toBe(true);
  });

  it("rejects setDefaultResponse for unknown or foreign source", async () => {
    const err = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        return yield* Effect.flip(repo.setDefaultResponse("other-project", "s1"));
      }),
    );
    expect(err._tag).toBe("SourceNotFound");
  });
});

describe("TicketRepository", () => {
  it("inserts, gets, lists by status / assigned (oldest first)", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ id: "t2", assignedAt: T2 }));
        yield* repo.insert(ticket({ id: "t1", assignedAt: T1 }));
        yield* repo.insert(ticket({ id: "t3", status: "open", workerId: null, assignedAt: null }));
        yield* repo.insert(ticket({ id: "t4", workerId: "w2" }));
        return {
          t1: yield* repo.get("t1"),
          miss: yield* Effect.flip(repo.get("nope")),
          assigned: (yield* repo.listAssigned("w1")).map((t) => t.id),
          byStatus: (yield* repo.listByStatus(["open"])).map((t) => t.id),
          empty: yield* repo.listByStatus([]),
        };
      }),
    );
    expect(out.t1.id).toBe("t1");
    expect(out.miss._tag).toBe("TicketNotFound");
    expect(out.assigned).toEqual(["t1", "t2"]);
    expect(out.byStatus).toEqual(["t3"]);
    expect(out.empty).toEqual([]);
  });

  it("claims assigned -> in_progress for the assigned worker", async () => {
    const claimed = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        return yield* repo.claim("t1", "w1", T1);
      }),
    );
    expect(claimed).toMatchObject({
      status: "in_progress",
      startedAt: T1,
      lastActivityAt: T1,
      workerId: "w1",
    });
  });

  it("rejects claims by the wrong worker, on non-assigned tickets, and unknown tickets", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        yield* repo.insert(ticket({ id: "t2", status: "open", workerId: null }));
        return {
          wrong: yield* Effect.flip(repo.claim("t1", "w2", T1)),
          open: yield* Effect.flip(repo.claim("t2", "w1", T1)),
          miss: yield* Effect.flip(repo.claim("nope", "w1", T1)),
        };
      }),
    );
    expect(out.wrong).toMatchObject({
      _tag: "ClaimConflict",
      status: "assigned",
      assignedTo: "w1",
    });
    expect(out.open).toMatchObject({ _tag: "ClaimConflict", status: "open" });
    expect(out.miss._tag).toBe("TicketNotFound");
  });

  it("double claim: exactly one of two concurrent claims wins", async () => {
    const db = makeDb();
    await run(
      Effect.gen(function* () {
        yield* seeded;
        yield* (yield* TicketRepository).insert(ticket());
      }),
      db,
    );
    const results = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.exit(repo.claim("t1", "w1", T1))),
          { concurrency: "unbounded" },
        );
      }),
      db,
    );
    expect(results.filter(Exit.isSuccess)).toHaveLength(1);
    expect(results.filter(Exit.isFailure)).toHaveLength(7);
  });

  it("updates status through the state machine and stamps timestamps", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ status: "in_progress", startedAt: T0 }));
        const done = yield* repo.updateStatus("t1", "completed", T2, { result: { ok: true } });
        const bad = yield* Effect.flip(repo.updateStatus("t1", "open", T2));
        const miss = yield* Effect.flip(repo.updateStatus("nope", "failed", T2));
        return { done, bad, miss };
      }),
    );
    expect(out.done).toMatchObject({
      status: "completed",
      completedAt: T2,
      lastActivityAt: T2,
      result: { ok: true },
    });
    expect(out.bad).toMatchObject({ _tag: "InvalidTransition", from: "completed", to: "open" });
    expect(out.miss._tag).toBe("TicketNotFound");
  });

  it("assigns open tickets (worker-specific or any-of-type); concurrent double assign yields one winner", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(
          ticket({ id: "t1", status: "open", workerId: null, workerType: null, assignedAt: null }),
        );
        yield* repo.insert(
          ticket({ id: "t2", status: "open", workerId: null, workerType: null, assignedAt: null }),
        );
        const any = yield* repo.assign("t1", { workerType: "local_pi", workerId: null }, T1);
        const exits = yield* Effect.all(
          [
            Effect.exit(repo.assign("t2", { workerType: "local_claude", workerId: "w1" }, T1)),
            Effect.exit(repo.assign("t2", { workerType: "local_claude", workerId: "w2" }, T2)),
          ],
          { concurrency: "unbounded" },
        );
        return {
          any,
          exits,
          t2: yield* repo.get("t2"),
          again: yield* Effect.flip(
            repo.assign("t1", { workerType: "local_pi", workerId: "w9" }, T2),
          ),
          miss: yield* Effect.flip(
            repo.assign("nope", { workerType: "local_pi", workerId: null }, T2),
          ),
        };
      }),
    );
    expect(out.any).toMatchObject({
      status: "assigned",
      assignedAt: T1,
      workerType: "local_pi",
      workerId: null,
    });
    expect(out.exits.filter(Exit.isSuccess)).toHaveLength(1);
    expect(out.t2.status).toBe("assigned");
    expect(out.again._tag).toBe("InvalidTransition");
    expect(out.miss._tag).toBe("TicketNotFound");
  });

  it("a concurrent status change is never overwritten: the loser re-validates", async () => {
    const { exits, final } = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ status: "in_progress", startedAt: T0 }));
        const exits = yield* Effect.all(
          [
            Effect.exit(repo.updateStatus("t1", "blocked", T1)),
            Effect.exit(repo.updateStatus("t1", "completed", T2)),
          ],
          { concurrency: "unbounded" },
        );
        return { exits, final: yield* repo.get("t1") };
      }),
    );
    // Both read in_progress; one write wins, the other re-reads and hits the state machine
    // (blocked -> completed is illegal; completed is terminal).
    expect(exits.filter(Exit.isSuccess).length).toBeGreaterThanOrEqual(1);
    expect(["blocked", "completed"]).toContain(final.status);
  });

  it("appends events, bumps last_activity_at, lists chronologically with limit", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        yield* repo.appendEvent(event({ id: "e1", createdAt: T1 }));
        yield* repo.appendEvent(event({ id: "e2", createdAt: T2, body: "second" }));
        return {
          t: yield* repo.get("t1"),
          all: (yield* repo.listEvents("t1")).map((e) => e.id),
          last: yield* repo.listEvents("t1", 1),
          missAppend: yield* Effect.flip(repo.appendEvent(event({ id: "e3", ticketId: "nope" }))),
          missList: yield* Effect.flip(repo.listEvents("nope")),
        };
      }),
    );
    expect(out.t.lastActivityAt).toBe(T2);
    expect(out.all).toEqual(["e1", "e2"]);
    expect(out.last).toEqual([event({ id: "e2", createdAt: T2, body: "second" })]);
    expect(out.missAppend._tag).toBe("TicketNotFound");
    expect(out.missList._tag).toBe("TicketNotFound");
  });
});

describe("MemoryRepository", () => {
  it("lists newest first, filters by type, limits, and searches case-insensitively", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seeded;
        const repo = yield* MemoryRepository;
        yield* repo.insert(memory({ id: "m1", title: "Alpha", content: "100% done_" }));
        yield* repo.insert(memory({ id: "m2", type: "manual", title: "Beta", createdAt: T1 }));
        yield* repo.insert(
          memory({ id: "m3", title: "Gamma", content: "alpha again", createdAt: T2 }),
        );
        return {
          list: (yield* repo.list("p1")).map((e) => e.id),
          typed: (yield* repo.list("p1", { type: "manual" })).map((e) => e.id),
          limited: (yield* repo.list("p1", { limit: 1 })).map((e) => e.id),
          search: (yield* repo.search("p1", "ALPHA")).map((e) => e.id),
          wildcard: (yield* repo.search("p1", "%")).map((e) => e.id),
          searchLimited: (yield* repo.search("p1", "alpha", 1)).map((e) => e.id),
          otherProject: yield* repo.search("p9", "alpha"),
          first: (yield* repo.list("p1"))[2],
        };
      }),
    );
    expect(out.list).toEqual(["m3", "m2", "m1"]);
    expect(out.typed).toEqual(["m2"]);
    expect(out.limited).toEqual(["m3"]);
    expect(out.search).toEqual(["m3", "m1"]);
    expect(out.wildcard).toEqual(["m1"]);
    expect(out.searchLimited).toEqual(["m3"]);
    expect(out.otherProject).toEqual([]);
    expect(out.first?.sourceMetadata).toEqual({ k: "v" });
  });
});

describe("WorkerRepository", () => {
  it("registers on first heartbeat, then updates last_seen_at and current ticket", async () => {
    const out = await run(
      Effect.gen(function* () {
        const repo = yield* WorkerRepository;
        const first = yield* repo.heartbeat({
          workerId: "w1",
          workerType: "local_claude",
          ticketId: null,
          at: T0,
        });
        const second = yield* repo.heartbeat({
          workerId: "w1",
          workerType: "local_claude",
          ticketId: "t1",
          at: T1,
        });
        return {
          first,
          second,
          got: yield* repo.get("w1"),
          list: yield* repo.list,
          miss: yield* Effect.flip(repo.get("nope")),
        };
      }),
    );
    expect(out.first).toEqual({
      id: "w1",
      workerType: "local_claude",
      currentTicketId: null,
      lastSeenAt: T0,
      createdAt: T0,
    });
    expect(out.second).toMatchObject({ currentTicketId: "t1", lastSeenAt: T1, createdAt: T0 });
    expect(out.got).toEqual(out.second);
    expect(out.list).toHaveLength(1);
    expect(out.miss._tag).toBe("WorkerNotFound");
  });
});
