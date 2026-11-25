import {
  type Run,
  type RunEvent,
  TicketRepository,
  type Ticket,
  ingestRun,
  listTicketRuns,
  pruneRuns,
  readTicketRun,
  recordSandboxRun,
  AssetStore,
  AssetStoreFailed,
  RunRepository,
  runChunkKey,
} from "@project-os/core";
import type { RunUpload } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "in_progress",
  title: "Fix login",
  intent: null,
  inputSummary: "Fix login",
  priority: null,
  workerType: "local",
  workerId: "w1",
  requester: { channelType: "discord", id: "u-ada" },
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: T0,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
  ...over,
});

const ev = (text: string, type: RunEvent["type"] = "output"): RunEvent => ({
  at: T0,
  type,
  text,
});

const chunk = (seq: number, events: RunEvent[], over: Partial<RunUpload> = {}): RunUpload => ({
  runId: "run-00000001",
  seq,
  agent: "claude",
  events,
  ...over,
});

const run = <A, E>(
  body: Effect.Effect<A, E, any>,
  options: Parameters<typeof makeTestLayer>[0] = {},
) => Effect.runPromise(Effect.provide(body, makeTestLayer(options).layer) as Effect.Effect<A, E>);

const withTicket = <A, E>(body: Effect.Effect<A, E, any>) =>
  run(
    Effect.gen(function* () {
      yield* (yield* TicketRepository).insert(ticket());
      return yield* body;
    }),
  );

describe("run logs", () => {
  it("stores chunks in order and reads them back as one transcript", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a"), ev("boom", "error")]));
        const done = yield* ingestRun(
          "t1",
          { id: "w1" },
          chunk(1, [ev("b")], { finished: { exitCode: 0 } }),
        );
        const read = yield* readTicketRun("t1", "run-00000001");
        return { done, read };
      }),
    );
    expect(out.done).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      eventCount: 3,
      errorCount: 1,
      nextSeq: 2,
    });
    expect(out.read.events.map((e) => e.text)).toEqual(["a", "boom", "b"]);
  });

  it("stores a resent chunk once and refuses a gap", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        const again = yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        const gap = yield* Effect.flip(ingestRun("t1", { id: "w1" }, chunk(5, [ev("z")])));
        return { again, gap };
      }),
    );
    expect(out.again).toMatchObject({ eventCount: 1, nextSeq: 1 });
    expect(out.gap).toMatchObject({ _tag: "RunOutOfOrder", expected: 1 });
  });

  it("takes uploads only from the ticket's own worker, for an id that is its own", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        const stranger = yield* Effect.flip(ingestRun("t1", { id: "w2" }, chunk(0, [ev("a")])));
        const missing = yield* Effect.flip(ingestRun("nope", { id: "w1" }, chunk(0, [ev("a")])));
        const badId = yield* Effect.flip(
          ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")], { runId: "../x" })),
        );
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        yield* (yield* TicketRepository).insert(ticket({ id: "t2" }));
        const hijack = yield* Effect.flip(ingestRun("t2", { id: "w1" }, chunk(1, [ev("b")])));
        return { stranger, missing, badId, hijack };
      }),
    );
    expect(out.stranger._tag).toBe("WorkerUnauthorized");
    expect(out.missing._tag).toBe("TicketNotFound");
    expect(out.badId._tag).toBe("RunRejected");
    expect(out.hijack._tag).toBe("RunRejected");
  });

  it("masks secrets before anything is stored", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun(
          "t1",
          { id: "w1" },
          chunk(0, [
            ev(
              "curl -H 'Authorization: Bearer abcdef1234567890' and ghp_abcdefghijklmnopqrstuvwxyz0123",
            ),
          ]),
        );
        return yield* readTicketRun("t1", "run-00000001");
      }),
    );
    expect(out.events[0]!.text).toBe("curl -H 'Authorization: Bearer [REDACTED]' and [REDACTED]");
  });

  it("stops keeping events past the size limit and says so", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        const big = "x".repeat(2_000);
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev(big)]), { maxBytes: 3_000 });
        const second = yield* ingestRun("t1", { id: "w1" }, chunk(1, [ev(big)]), {
          maxBytes: 3_000,
        });
        yield* ingestRun("t1", { id: "w1" }, chunk(2, [ev("later")]), { maxBytes: 3_000 });
        return { second, read: yield* readTicketRun("t1", "run-00000001") };
      }),
    );
    expect(out.second.truncated).toBe(true);
    expect(out.read.events.map((e) => e.text)).toEqual([
      "x".repeat(2_000),
      expect.stringContaining("limit per run was reached"),
    ]);
  });

  it("lets a requester see only their own ticket's runs", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        const mine = yield* listTicketRuns("t1", { channelType: "discord", id: "u-ada" });
        const bobs = yield* Effect.flip(
          listTicketRuns("t1", { channelType: "discord", id: "u-bob" }),
        );
        const crossRead = yield* Effect.flip(
          readTicketRun("t1", "run-nope0000", { channelType: "discord", id: "u-ada" }),
        );
        return { mine, bobs, crossRead };
      }),
    );
    expect(out.mine).toHaveLength(1);
    expect(out.bobs._tag).toBe("TicketNotFound");
    expect(out.crossRead._tag).toBe("RunNotFound");
  });

  it("keeps a sandbox session's output, masking the values it was given", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* recordSandboxRun({
          ticketId: "t1",
          workerId: "w1",
          agent: "pi",
          model: "m",
          startedAt: T0,
          exitCode: 1,
          output: "hello\n\nkey is tok-0123456789\n",
          secrets: ["tok-0123456789"],
        });
        const [only] = yield* listTicketRuns("t1");
        return yield* readTicketRun("t1", only!.id);
      }),
    );
    expect(out.run).toMatchObject({ agent: "pi", status: "failed", exitCode: 1, eventCount: 3 });
    expect(out.events.map((e) => e.text)).toEqual([
      "hello",
      "key is [REDACTED]",
      "Session exited with code 1.",
    ]);
  });

  it("deletes transcripts past retention and keeps the summary", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket());
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")], { finished: { exitCode: 0 } }));
        // Not old enough yet: the test clock is at 2026-11-04.
        const none = yield* pruneRuns(DAY);
        const pruned = yield* pruneRuns(-DAY);
        const read = yield* readTicketRun("t1", "run-00000001");
        const stored: Run | undefined = yield* (yield* RunRepository).get("run-00000001");
        return { none, pruned, read, stored };
      }),
    );
    expect(out.none).toBe(0);
    expect(out.pruned).toBe(1);
    expect(out.stored).toMatchObject({ expired: true, eventCount: 1 });
    expect(out.read.events).toEqual([]);
  });

  it("rejects a negative seq and an oversized chunk", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        const negative = yield* Effect.flip(ingestRun("t1", { id: "w1" }, chunk(-1, [ev("a")])));
        const huge = yield* Effect.flip(
          ingestRun(
            "t1",
            { id: "w1" },
            chunk(
              0,
              Array.from({ length: 501 }, () => ev("a")),
            ),
          ),
        );
        return { negative, huge };
      }),
    );
    expect(out.negative._tag).toBe("RunRejected");
    expect(out.huge._tag).toBe("RunRejected");
  });

  it("skips a damaged line and a missing chunk when reading", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        yield* ingestRun("t1", { id: "w1" }, chunk(1, [ev("b")]));
        const store = yield* AssetStore;
        const bytes = new TextEncoder().encode(
          'not json\n\n{"at":"t","type":"output","text":"ok"}\n',
        );
        yield* store.put({
          key: runChunkKey("t1", "run-00000001", 0),
          body: new Response(bytes).body!,
          contentType: "application/x-ndjson",
          size: bytes.length,
          maxBytes: bytes.length,
        });
        yield* store.remove(runChunkKey("t1", "run-00000001", 1));
        return yield* readTicketRun("t1", "run-00000001");
      }),
    );
    expect(out.events.map((e) => e.text)).toEqual(["ok"]);
  });

  it("applies the exit once, and drops events sent after it", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")], { finished: { exitCode: 1 } }));
        const late = yield* ingestRun(
          "t1",
          { id: "w1" },
          chunk(1, [ev("late")], { finished: { exitCode: 0 } }),
        );
        return late;
      }),
    );
    expect(out).toMatchObject({ status: "failed", exitCode: 1, eventCount: 1 });
  });

  it("finishes a run with an empty last chunk", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        return yield* ingestRun("t1", { id: "w1" }, chunk(1, [], { finished: { exitCode: 0 } }));
      }),
    );
    expect(out).toMatchObject({ status: "succeeded", nextSeq: 1, eventCount: 1 });
  });

  it("splits a long sandbox output into chunks and reads it all back", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        const output = Array.from({ length: 1_200 }, (_, i) => `line ${i}`).join("\n");
        yield* recordSandboxRun({
          ticketId: "t1",
          workerId: "w1",
          agent: "pi",
          model: "m",
          startedAt: T0,
          exitCode: 0,
          output,
          secrets: [],
        });
        const [only] = yield* listTicketRuns("t1");
        return { only, read: yield* readTicketRun("t1", only!.id) };
      }),
    );
    expect(out.only).toMatchObject({ nextSeq: 3, eventCount: 1_201, status: "succeeded" });
    expect(out.read.events).toHaveLength(1_201);
  });

  it("leaves a run for the next sweep when its transcript can't be deleted", async () => {
    const out = await withTicket(
      Effect.gen(function* () {
        yield* ingestRun("t1", { id: "w1" }, chunk(0, [ev("a")]));
        const store = yield* AssetStore;
        const failing = {
          ...store,
          remove: () => Effect.fail(new AssetStoreFailed({ message: "x" })),
        };
        const pruned = yield* pruneRuns(-DAY).pipe(Effect.provideService(AssetStore, failing));
        return { pruned, run: yield* (yield* RunRepository).get("run-00000001") };
      }),
    );
    expect(out.pruned).toBe(0);
    expect(out.run?.expired).toBe(false);
  });
});
