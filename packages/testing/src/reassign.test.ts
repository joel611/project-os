import {
  claimTicketUseCase,
  heartbeat,
  listAssigned,
  readAudit,
  reassignTicketTo,
  TicketRepository,
  WorkerRepository,
  type Ticket,
} from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const OPERATOR = { type: "person", id: "op1", name: "Olga" } as const;

const stuck = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "in_progress",
  title: "t",
  intent: null,
  inputSummary: "t",
  priority: null,
  workerType: "local",
  workerId: "old",
  requester: null,
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

const device = (id: string) =>
  Effect.flatMap(WorkerRepository, (repo) =>
    repo.register({
      id,
      workerType: "local",
      owner: null,
      name: `box-${id}`,
      secretHash: `hash-${id}`,
      at: T0,
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer().layer) as Effect.Effect<A, E>);

describe("reassignTicketTo", () => {
  it("hands a stuck ticket to another device, which then lists and claims it", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(stuck());
        yield* device("new");
        const reassigned = yield* reassignTicketTo({
          ticketId: "t1",
          workerId: "new",
          by: OPERATOR,
        });
        const listed = yield* listAssigned({ workerId: "new" });
        const claimed = yield* claimTicketUseCase({ ticketId: "t1", workerId: "new" });
        const events = yield* (yield* TicketRepository).listEvents("t1");
        const audit = (yield* readAudit({ kind: "ticket" })).entries;
        return { reassigned, listed, claimed, events, audit };
      }),
    );
    expect(out.reassigned).toMatchObject({ status: "assigned", workerId: "new", startedAt: null });
    expect(out.listed.map((t) => t.id)).toEqual(["t1"]);
    expect(out.claimed.status).toBe("in_progress");
    expect(out.events.map((e) => e.body)).toEqual(["Reassigned from old to box-new by Olga"]);
    expect(out.audit.find((e) => e.action === "assigned")).toMatchObject({
      actorType: "person",
      actorId: "op1",
      workerId: "new",
      payload: { from: "in_progress", status: "assigned" },
    });
  });

  it("assigns an open ticket with no worker yet", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(
          stuck({ status: "open", workerType: null, workerId: null, assignedAt: null }),
        );
        yield* device("new");
        yield* reassignTicketTo({ ticketId: "t1", workerId: "new", by: OPERATOR });
        return yield* (yield* TicketRepository).listEvents("t1");
      }),
    );
    expect(out.map((e) => e.body)).toEqual(["Assigned to box-new by Olga"]);
  });

  it("refuses an unknown worker, a sandbox session, and a finished ticket", async () => {
    const out = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(stuck());
        yield* repo.insert(stuck({ id: "t2", status: "completed", completedAt: T0 }));
        yield* device("new");
        yield* heartbeat({ workerId: "daytona-t9", workerType: "daytona_pi" });
        const to = (ticketId: string, workerId: string) =>
          Effect.flip(reassignTicketTo({ ticketId, workerId, by: OPERATOR }));
        return {
          unknown: yield* to("t1", "nope"),
          sandbox: yield* to("t1", "daytona-t9"),
          finished: yield* to("t2", "new"),
          still: yield* repo.get("t1"),
        };
      }),
    );
    expect(out.unknown._tag).toBe("WorkerNotFound");
    expect(out.sandbox._tag).toBe("WorkerNotFound");
    expect(out.finished._tag).toBe("InvalidTransition");
    expect(out.still).toMatchObject({ status: "in_progress", workerId: "old" });
  });
});
