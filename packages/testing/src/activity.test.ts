import {
  heartbeat,
  ProjectSourceRepository,
  readActivity,
  TicketRepository,
  type Ticket,
} from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

// The test clock reads T0; the default look-back without `since` is 15 minutes.
const T0 = "2026-11-04T00:00:00.000Z";
const OLD = "2026-11-03T23:00:00.000Z";

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id,
  projectId: "p1",
  status: "assigned",
  title: id,
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: "local",
  workerId: "w1",
  requester: null,
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

const run = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer().layer) as Effect.Effect<A>);

describe("readActivity", () => {
  it("baselines with in-flight tickets, recent changes and workers; finished old ones drop out", async () => {
    const feed = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const sources = yield* ProjectSourceRepository;
        yield* sources.insert({
          id: "s1",
          projectId: "p1",
          type: "email_address",
          externalId: "support@acme.co",
          name: "support@",
          alias: "support",
          description: null,
          direction: "both",
          isDefaultResponse: true,
          config: {},
          status: "active",
          connectedBy: null,
          createdAt: T0,
          updatedAt: T0,
        });
        yield* tickets.insert(ticket("fresh"));
        yield* tickets.appendEvent({
          id: "e1",
          ticketId: "fresh",
          type: "created",
          actor: "coordinator",
          actorId: null,
          body: "hi",
          payload: { channelType: "email", sender: { id: "p@acme.co", email: "p@acme.co" } },
          createdAt: T0,
        });
        yield* tickets.insert(ticket("stale-live", { updatedAt: OLD }));
        yield* tickets.appendEvent({
          id: "e2",
          ticketId: "stale-live",
          type: "created",
          actor: "coordinator",
          actorId: null,
          body: "",
          payload: null,
          createdAt: OLD,
        });
        yield* tickets.insert(ticket("stale-done", { status: "completed", updatedAt: OLD }));
        yield* heartbeat({ workerId: "w1", workerType: "local" });
        return yield* readActivity({ staleAfterMs: 60_000 });
      }),
    );
    expect(feed.now).toBe(T0);
    expect(feed.tickets.map((t) => [t.id, t.origin?.channelType ?? null, t.replyChannel])).toEqual([
      ["fresh", "email", "email"],
      ["stale-live", null, "email"],
    ]);
    expect(feed.events.map((e) => e.id)).toEqual(["e1"]);
    expect(feed.workers).toMatchObject([{ id: "w1", status: "online" }]);
  });

  it("with since, returns only what changed, and no reply channel when the project has none", async () => {
    const feed = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        yield* tickets.insert(ticket("old-live", { updatedAt: OLD }));
        yield* tickets.insert(ticket("new", { updatedAt: T0 }));
        return yield* readActivity({ since: "2026-11-03T23:30:00.000Z", staleAfterMs: 60_000 });
      }),
    );
    expect(feed.tickets.map((t) => [t.id, t.origin, t.replyChannel])).toEqual([
      ["new", null, null],
    ]);
  });
});
