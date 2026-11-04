import {
  Clock,
  healthSweep,
  TicketNotFound,
  TicketRepository,
  WorkerRepository,
  type HealthThresholds,
  type TicketEvent,
  type Ticket,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  IdGeneratorSequential,
  TicketRepositoryInMemory,
  WorkerRepositoryInMemory,
} from "./index.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-04T00:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

const thresholds: HealthThresholds = {
  workerStaleMs: 15 * MIN,
  unpickedMs: 30 * MIN,
  followUpMs: 15 * MIN,
  inactivityFailMs: 30 * MIN,
};

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "assigned",
  title: "t",
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: "local_claude",
  workerId: "w1",
  result: null,
  error: null,
  createdAt: iso(0),
  assignedAt: iso(0),
  startedAt: null,
  lastActivityAt: iso(0),
  completedAt: null,
  updatedAt: iso(0),
  ...over,
});

const inProgress = (over: Partial<Ticket> = {}) =>
  ticket({ status: "in_progress", startedAt: iso(0), ...over });

/** Runs `scenario(setNow)` against in-memory repos and a controllable clock. */
const scenario = <A>(
  body: (setNow: (minutes: number) => void) => Effect.Effect<A, unknown, any>,
  tickets: Layer.Layer<TicketRepository> = TicketRepositoryInMemory,
): Promise<A> => {
  let nowMs = T0;
  const layer = Layer.mergeAll(
    Layer.succeed(Clock, { now: Effect.sync(() => new Date(nowMs)) }),
    IdGeneratorSequential,
    tickets,
    WorkerRepositoryInMemory,
  );
  const program = body((m) => {
    nowMs = T0 + m * MIN;
  });
  return Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A>);
};

const beat = (workerId: string, minutes: number) =>
  Effect.flatMap(WorkerRepository, (w) =>
    w.heartbeat({ workerId, workerType: "local_claude", ticketId: null, at: iso(minutes) }),
  );

describe("healthSweep: assigned tickets", () => {
  it("leaves a fresh assignment alone", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        yield* beat("w1", 0);
        setNow(29);
        yield* beat("w1", 29);
        expect(yield* healthSweep(thresholds)).toEqual([]);
      }),
    ));

  it("flags an unpicked assignment after 30 min, once", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        yield* beat("w1", 0);
        setNow(30);
        yield* beat("w1", 30);
        const first = yield* healthSweep(thresholds);
        expect(first).toEqual([
          { kind: "assignment_flagged", ticketId: "t1", reason: "not picked up in time" },
        ]);
        const events = yield* repo.listEvents("t1");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: "system", actor: "system" });
        setNow(31);
        expect(yield* healthSweep(thresholds)).toEqual([]);
        expect(yield* repo.listEvents("t1")).toHaveLength(1);
      }),
    ));

  it("flags immediately when the assigned worker is offline", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ assignedAt: iso(10), lastActivityAt: iso(10) }));
        yield* beat("w1", 0);
        setNow(16);
        expect(yield* healthSweep(thresholds)).toEqual([
          { kind: "assignment_flagged", ticketId: "t1", reason: "worker offline" },
        ]);
      }),
    ));

  it("ignores assignments with no worker and falls back to createdAt", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ workerId: null, assignedAt: null }));
        setNow(30);
        expect(yield* healthSweep(thresholds)).toHaveLength(1);
      }),
    ));

  it("keeps sweeping when one ticket errors", () =>
    scenario(
      (setNow) =>
        Effect.gen(function* () {
          const repo = yield* TicketRepository;
          yield* repo.insert(ticket());
          yield* repo.insert(ticket({ id: "t2" }));
          setNow(30);
          const actions = yield* healthSweep(thresholds);
          expect(actions.map((a) => a.ticketId)).toEqual(["t2"]);
        }),
      // appendEvent fails for t1 only.
      Layer.effect(
        TicketRepository,
        Effect.map(TicketRepository, (repo) => ({
          ...repo,
          appendEvent: (e: TicketEvent) =>
            e.ticketId === "t1"
              ? Effect.fail(new TicketNotFound({ ticketId: "t1" }))
              : repo.appendEvent(e),
        })),
      ).pipe(Layer.provide(TicketRepositoryInMemory)),
    ));
});

describe("healthSweep: in_progress tickets", () => {
  it("is quiet below 15 min of inactivity", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(inProgress());
        yield* beat("w1", 14);
        setNow(14);
        expect(yield* healthSweep(thresholds)).toEqual([]);
      }),
    ));

  it("sends one follow_up at 15 min and does not repeat", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(inProgress());
        yield* beat("w1", 15);
        setNow(15);
        expect(yield* healthSweep(thresholds)).toEqual([{ kind: "follow_up", ticketId: "t1" }]);
        const events = yield* repo.listEvents("t1");
        expect(events[0]).toMatchObject({ type: "follow_up", actor: "system" });
        setNow(20);
        yield* beat("w1", 20);
        expect(yield* healthSweep(thresholds)).toEqual([]);
      }),
    ));

  it("fails after 30 min even though the follow_up bumped lastActivityAt", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(inProgress());
        yield* beat("w1", 15);
        setNow(15);
        yield* healthSweep(thresholds);
        setNow(30);
        yield* beat("w1", 30);
        expect(yield* healthSweep(thresholds)).toEqual([
          { kind: "failed", ticketId: "t1", reason: "no activity" },
        ]);
        const t = yield* repo.get("t1");
        expect(t.status).toBe("failed");
        expect(t.error).toContain("no activity");
      }),
    ));

  it("follows up again after the worker shows activity and goes idle again", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(inProgress());
        yield* beat("w1", 15);
        setNow(15);
        yield* healthSweep(thresholds);
        setNow(20);
        yield* beat("w1", 20);
        yield* repo.appendEvent({
          id: "w-1",
          ticketId: "t1",
          type: "status_update",
          actor: "worker",
          actorId: "w1",
          body: "working",
          payload: null,
          createdAt: iso(20),
        });
        setNow(35);
        yield* beat("w1", 35);
        expect(yield* healthSweep(thresholds)).toEqual([{ kind: "follow_up", ticketId: "t1" }]);
      }),
    ));

  it("fails immediately when the worker is offline", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(inProgress({ lastActivityAt: iso(9) }));
        yield* beat("w1", 0);
        setNow(16);
        expect(yield* healthSweep(thresholds)).toEqual([
          { kind: "failed", ticketId: "t1", reason: "worker offline" },
        ]);
        expect((yield* repo.get("t1")).status).toBe("failed");
      }),
    ));

  it("ignores terminal and other-status tickets", () =>
    scenario((setNow) =>
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ id: "a", status: "completed" }));
        yield* repo.insert(ticket({ id: "b", status: "blocked" }));
        yield* repo.insert(ticket({ id: "c", status: "open", workerId: null }));
        setNow(120);
        expect(yield* healthSweep(thresholds)).toEqual([]);
      }),
    ));
});
