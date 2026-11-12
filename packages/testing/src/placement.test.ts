import {
  authenticateSandbox,
  heartbeat,
  issueWorkerRegistration,
  placeOrQueue,
  redeemWorkerRegistration,
  TicketRepository,
  WorkerRepository,
  type PlaceRequest,
  type Person,
  type Ticket,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const ADA: Person = { channelType: "discord", id: "u1", name: "Ada" };
const BOB: Person = { channelType: "discord", id: "u2", name: "Bob" };

const openTicket = (id: string, requester: Person = ADA): Ticket => ({
  id,
  projectId: "p1",
  status: "open",
  title: "t",
  intent: null,
  inputSummary: "t",
  priority: null,
  workerType: null,
  workerId: null,
  requester: { channelType: requester.channelType, id: requester.id },
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: null,
  startedAt: null,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
});

/** Inserts an open ticket and places it, as handleInbound does for a new request. */
const place = (id: string, over: Partial<PlaceRequest> = {}, requester: Person = ADA) =>
  Effect.gen(function* () {
    yield* (yield* TicketRepository).insert(openTicket(id, requester));
    return yield* placeOrQueue({ ticketId: id, requester, routing: {}, at: T0, ...over });
  });

const events = (id: string) =>
  Effect.flatMap(TicketRepository, (repo) => repo.listEvents(id)).pipe(
    Effect.map((all) => all.map((e) => ({ type: e.type, body: e.body, payload: e.payload }))),
  );

/** Registers a device for `person`; `online` heartbeats it at the (fixed) current time. */
const personalDevice = (person: Person, online: boolean, name?: string) =>
  Effect.gen(function* () {
    const { token } = yield* issueWorkerRegistration(person);
    const out = yield* redeemWorkerRegistration({ token, ...(name ? { name } : {}) });
    if (online) yield* heartbeat({ workerId: out.worker.id, workerType: out.worker.workerType });
    return out;
  });

/** A shared device an admin registered; online unless told otherwise. */
const sharedDevice = (id: string, online = true) =>
  Effect.gen(function* () {
    yield* (yield* WorkerRepository).register({
      id,
      workerType: "local",
      owner: null,
      name: id,
      secretHash: `hash-${id}`,
      at: T0,
    });
    if (online) yield* heartbeat({ workerId: id, workerType: "local" });
  });

type Options = Parameters<typeof makeTestLayer>[0];

const run = <A>(eff: Effect.Effect<A, unknown, any>, options: Options = {}) => {
  const t = makeTestLayer(options);
  return Effect.runPromise(eff.pipe(Effect.provide(t.layer)) as Effect.Effect<A>).then((value) => ({
    value,
    launched: t.launched,
  }));
};

const daytona = { sandboxPool: [{ workerType: "daytona_pi" as const }] };

describe("placeOrQueue: where a ticket goes", () => {
  it("gives a new ticket to the requester's online device, and launches nothing", async () => {
    const { value, launched } = await run(
      Effect.gen(function* () {
        const { worker } = yield* personalDevice(ADA, true);
        const placement = yield* place("t1");
        return { worker, placement, log: yield* events("t1") };
      }),
      daytona,
    );
    expect(value.placement).toMatchObject({
      kind: "placed",
      workerId: value.worker.id,
      ticket: { status: "assigned", workerType: "local", workerId: value.worker.id },
    });
    expect(value.log).toEqual([
      {
        type: "assigned",
        body: `Assigned to the requester's own worker ${value.worker.name}`,
        payload: {
          workerType: "local",
          workerId: value.worker.id,
          personal: true,
          kind: "personal",
        },
      },
    ]);
    expect(launched).toEqual([]);
  });

  it("prefers the requester's most recently seen online device", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const a = yield* personalDevice(ADA, true, "a");
        const b = yield* personalDevice(ADA, true, "b");
        yield* (yield* WorkerRepository).heartbeat({
          workerId: a.worker.id,
          workerType: "local",
          ticketId: null,
          at: "2026-11-03T23:59:00.000Z",
        });
        return { placement: yield* place("t1"), b: b.worker.id };
      }),
    );
    expect(value.placement).toMatchObject({ kind: "placed", workerId: value.b });
  });

  it("goes to the sandbox pool when the requester's device is offline or it is someone else's", async () => {
    const { value, launched } = await run(
      Effect.gen(function* () {
        yield* personalDevice(ADA, false);
        yield* personalDevice(BOB, true);
        return yield* place("t1");
      }),
      daytona,
    );
    expect(value).toMatchObject({
      kind: "placed",
      workerId: "daytona-t1",
      ticket: { workerType: "daytona_pi", workerId: "daytona-t1" },
    });
    expect(launched).toEqual([
      {
        ticketId: "t1",
        workerType: "daytona_pi",
        workerId: "daytona-t1",
        mcpToken: expect.stringMatching(/^[\w-]{40,}$/),
      },
    ]);
  });

  it("issues the sandbox session a token that acts as its worker id", async () => {
    const t = makeTestLayer(daytona);
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* place("t1");
        return yield* authenticateSandbox(t.launched[0]!.mcpToken);
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<string | undefined>,
    );
    expect(out).toBe("daytona-t1");
  });

  it("starts the first sandbox provider in pool order", async () => {
    const { value, launched } = await run(place("t1"), {
      sandboxPool: [{ workerType: "cloudflare_pi" }, { workerType: "daytona_pi" }],
    });
    expect(value).toMatchObject({ kind: "placed", workerId: "cloudflare-t1" });
    expect(launched.map((l) => [l.workerType, l.workerId])).toEqual([
      ["cloudflare_pi", "cloudflare-t1"],
    ]);
  });

  it("skips a provider at its cap and takes the next", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const first = yield* place("t1");
        const second = yield* place("t2");
        return [first, second].map((p) => p.ticket.workerType);
      }),
      {
        sandboxPool: [
          { workerType: "cloudflare_pi", maxConcurrent: 1 },
          { workerType: "daytona_pi" },
        ],
      },
    );
    expect(value).toEqual(["cloudflare_pi", "daytona_pi"]);
  });

  it("prefers a free shared device over the sandbox pool, and launches nothing", async () => {
    const { value, launched } = await run(
      Effect.gen(function* () {
        yield* sharedDevice("w1");
        const placement = yield* place("t1");
        return { placement, log: yield* events("t1") };
      }),
      daytona,
    );
    expect(value.placement).toMatchObject({ kind: "placed", workerId: "w1" });
    expect(value.log).toEqual([
      {
        type: "assigned",
        body: "Assigned to the shared worker w1",
        payload: { workerType: "local", workerId: "w1", personal: false, kind: "shared" },
      },
    ]);
    expect(launched).toEqual([]);
  });

  it("moves on once a shared device holds its cap, to a less loaded one, then the pool", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* sharedDevice("w1");
        yield* sharedDevice("w2");
        const picks = [];
        for (const id of ["t1", "t2", "t3"]) {
          picks.push(
            (yield* place(id, { routing: { sharedWorkerMaxTickets: 1 } })).ticket.workerId,
          );
        }
        return picks;
      }),
      daytona,
    );
    expect(value.slice(0, 2).sort()).toEqual(["w1", "w2"]);
    expect(value[2]).toBe("daytona-t3");
  });

  it("holds a shared device to one ticket at a time unless told otherwise", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* sharedDevice("w1");
        const first = yield* place("t1");
        const second = yield* place("t2");
        const roomy = yield* place("t3", { routing: { sharedWorkerMaxTickets: 2 } });
        return [first.kind, second.kind, roomy.kind];
      }),
    );
    expect(value).toEqual(["placed", "queued", "placed"]);
  });

  it("ignores an offline shared device", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* sharedDevice("w-off", false);
        return yield* place("t1");
      }),
      daytona,
    );
    expect(value).toMatchObject({ kind: "placed", workerId: "daytona-t1" });
  });

  it("treats a device as stale after routing.workerStaleMs", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* sharedDevice("w1");
        yield* (yield* WorkerRepository).heartbeat({
          workerId: "w1",
          workerType: "local",
          ticketId: null,
          at: "2026-11-03T23:00:00.000Z",
        });
        return [
          (yield* place("t1", { routing: { workerStaleMs: 30 * 60_000 } })).kind,
          (yield* place("t2", { routing: { workerStaleMs: 90 * 60_000 } })).kind,
        ];
      }),
    );
    expect(value).toEqual(["queued", "placed"]);
  });
});

describe("placeOrQueue: Queued", () => {
  it("leaves the ticket open with no worker, and marks it Queued once", async () => {
    const { value, launched } = await run(
      Effect.gen(function* () {
        const placement = yield* place("t1");
        return { placement, log: yield* events("t1") };
      }),
    );
    expect(value.placement).toMatchObject({
      kind: "queued",
      ticket: { status: "open", workerType: null, workerId: null },
    });
    expect(value.log).toEqual([
      { type: "system", body: "Queued: no worker is free", payload: { kind: "queued" } },
    ]);
    expect(launched).toEqual([]);
  });

  it("writes nothing when a ticket that was already Queued stays Queued", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* place("t1");
        const again = yield* placeOrQueue({
          ticketId: "t1",
          requester: ADA,
          routing: {},
          at: T0,
          alreadyQueued: true,
        });
        return { again, log: yield* events("t1") };
      }),
    );
    expect(value.again.kind).toBe("queued");
    expect(value.log).toHaveLength(1);
  });

  it("places a Queued ticket once a worker has room, with no second Queued marker", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* place("t1");
        yield* sharedDevice("w1");
        const placement = yield* placeOrQueue({
          ticketId: "t1",
          requester: ADA,
          routing: {},
          at: T0,
          alreadyQueued: true,
        });
        return { placement, log: (yield* events("t1")).map((e) => e.type) };
      }),
    );
    expect(value.placement).toMatchObject({ kind: "placed", workerId: "w1" });
    expect(value.log).toEqual(["system", "assigned"]);
  });
});

describe("placeOrQueue: the Sidekick", () => {
  it("assigns and claims at once under the Sidekick's own id, whatever workers are free", async () => {
    const { value, launched } = await run(
      Effect.gen(function* () {
        yield* sharedDevice("w1");
        const placement = yield* place("t1", { executor: "sidekick" });
        return { placement, log: yield* events("t1") };
      }),
      daytona,
    );
    expect(value.placement).toMatchObject({
      kind: "placed",
      workerId: "sidekick",
      ticket: { status: "in_progress", workerType: "sidekick", workerId: "sidekick" },
    });
    expect(value.log).toEqual([
      {
        type: "assigned",
        body: "Assigned to the Sidekick",
        payload: { workerType: "sidekick", workerId: "sidekick" },
      },
    ]);
    expect(launched).toEqual([]);
  });
});

/** The in-memory ticket store, but each capacity read hands other fibers a turn. */
const interleaved = (layer: Layer.Layer<TicketRepository>) =>
  Layer.effect(
    TicketRepository,
    Effect.gen(function* () {
      const repo = yield* TicketRepository;
      return {
        ...repo,
        listByStatus: (statuses) => Effect.tap(repo.listByStatus(statuses), () => Effect.yieldNow),
      } satisfies typeof TicketRepository.Service;
    }),
  ).pipe(Layer.provideMerge(layer));

describe("placeOrQueue: concurrent placements", () => {
  const raced = (
    options: Options,
    ids: ReadonlyArray<string>,
    ready: Effect.Effect<void, never, any>,
  ) => {
    const t = makeTestLayer(options);
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* ready;
        const repo = yield* TicketRepository;
        for (const id of ids) yield* repo.insert(openTicket(id));
        const placements = yield* Effect.forEach(
          ids,
          (id) => placeOrQueue({ ticketId: id, requester: ADA, routing: {}, at: T0 }),
          { concurrency: "unbounded" },
        );
        const held = yield* repo.listByStatus(["assigned", "in_progress"]);
        return {
          kinds: placements.map((p) => p.kind),
          held: held.map((h) => h.id).sort(),
          open: (yield* repo.listByStatus(["open"])).map((o) => ({
            id: o.id,
            workerId: o.workerId,
            workerType: o.workerType,
          })),
          log: (yield* events(ids[0]!)).map((e) => e.type),
        };
      }).pipe(Effect.provide(interleaved(t.layer))) as Effect.Effect<any>,
    ).then((value) => ({ value, launched: t.launched }));
  };

  it("never fills a shared device past its cap, whichever ticket assigns first", async () => {
    for (const order of [
      ["t1", "t2"],
      ["t2", "t1"],
    ]) {
      const { value } = await raced({}, order, sharedDevice("w1"));
      expect(value.held).toHaveLength(1);
      expect(value.kinds.sort()).toEqual(["placed", "queued"]);
      expect(value.open).toHaveLength(1);
      expect(value.open[0]).toMatchObject({ workerId: null, workerType: null });
    }
  });

  it("marks the ticket that lost the slot Queued", async () => {
    const t = makeTestLayer({});
    const log = await Effect.runPromise(
      Effect.gen(function* () {
        yield* sharedDevice("w1");
        const repo = yield* TicketRepository;
        yield* repo.insert(openTicket("t1"));
        yield* repo.insert(openTicket("t2"));
        yield* Effect.forEach(
          ["t1", "t2"],
          (id) => placeOrQueue({ ticketId: id, requester: ADA, routing: {}, at: T0 }),
          { concurrency: "unbounded" },
        );
        // t2 takes the slot after t1 and sees t1 holding it.
        return yield* events("t2");
      }).pipe(Effect.provide(interleaved(t.layer))) as Effect.Effect<any>,
    );
    expect(log).toEqual([
      expect.objectContaining({
        type: "system",
        body: "Queued: its worker filled up meanwhile",
        payload: { kind: "queued" },
      }),
    ]);
  });

  it("never launches more sandboxes than the provider's cap", async () => {
    const { value, launched } = await raced(
      { sandboxPool: [{ workerType: "daytona_pi", maxConcurrent: 1 }] },
      ["t1", "t2", "t3"],
      Effect.void,
    );
    expect(value.held).toHaveLength(1);
    expect(value.kinds.filter((k: string) => k === "placed")).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });
});

describe("placeOrQueue: a launch that fails", () => {
  it("gives the slot back and returns the ticket to Queued, with its marker", async () => {
    const t = makeTestLayer({
      sandboxPool: [{ workerType: "daytona_pi", maxConcurrent: 1 }],
      failLaunch: "no capacity",
    });
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* place("t1");
        const log = yield* events("t1");
        t.setLaunchFailure(undefined);
        // The failed launch must not still count against the provider's cap.
        const second = yield* place("t2");
        return { first, log, second };
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<any>,
    );
    expect(value.first).toMatchObject({
      kind: "queued",
      ticket: { status: "open", workerType: null, workerId: null, assignedAt: null },
    });
    expect(value.log).toEqual([
      {
        type: "system",
        body: "Queued: could not start daytona-t1: no capacity",
        payload: { kind: "queued" },
      },
    ]);
    expect(value.second).toMatchObject({ kind: "placed", workerId: "daytona-t2" });
    expect(t.launched.map((l) => l.ticketId)).toEqual(["t2"]);
  });

  it("revokes the session's token", async () => {
    const t = makeTestLayer({ ...daytona, failLaunch: "boom" });
    const token = await Effect.runPromise(
      Effect.gen(function* () {
        yield* place("t1");
        return yield* authenticateSandbox(t.launchAttempts[0]!.mcpToken);
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<string | undefined>,
    );
    expect(t.launchAttempts).toHaveLength(1);
    expect(token).toBeUndefined();
  });

  it("is retried by the next placement, silently while it stays Queued", async () => {
    const t = makeTestLayer({ ...daytona, failLaunch: "boom" });
    const retry = () =>
      placeOrQueue({ ticketId: "t1", requester: ADA, routing: {}, at: T0, alreadyQueued: true });
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        yield* place("t1");
        const stillFailing = yield* retry();
        const logAfterFailure = yield* events("t1");
        t.setLaunchFailure(undefined);
        const recovered = yield* retry();
        return { stillFailing, logAfterFailure, recovered, log: yield* events("t1") };
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<any>,
    );
    expect(value.stillFailing.kind).toBe("queued");
    expect(value.logAfterFailure).toHaveLength(1);
    expect(value.recovered).toMatchObject({ kind: "placed", workerId: "daytona-t1" });
    expect(value.log.map((e: { type: string }) => e.type)).toEqual(["system", "assigned"]);
    expect(t.launched.map((l) => l.workerId)).toEqual(["daytona-t1"]);
  });
});
