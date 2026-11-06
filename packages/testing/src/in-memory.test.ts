import {
  ProjectSourceRepository,
  TicketRepository,
  type ProjectSource,
  type Ticket,
} from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";

const source = (over: Partial<ProjectSource> = {}): ProjectSource => ({
  id: "s1",
  projectId: "p1",
  type: "discord_channel",
  externalId: "chan-1",
  name: "#general",
  alias: `src-${over.id ?? "s1"}`,
  description: null,
  direction: "both",
  isDefaultResponse: false,
  config: {},
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

const run = <A, E>(eff: Effect.Effect<A, E, any>) =>
  Effect.runPromise(eff.pipe(Effect.provide(makeTestLayer().layer)) as Effect.Effect<A, E>);

describe("1:1 channel → project", () => {
  it("rejects linking a channel already linked to another project", async () => {
    const err = await run(
      Effect.gen(function* () {
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        return yield* Effect.flip(repo.insert(source({ id: "s2", projectId: "p2" })));
      }),
    );
    expect(err).toMatchObject({ _tag: "SourceAlreadyLinked", projectId: "p1" });
  });

  it("same external id under a different type is allowed", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        yield* repo.insert(source({ id: "s2", type: "email_address" }));
      }),
    );
  });

  it("resolves channel → project, and undefined when unlinked", async () => {
    const [hit, miss] = await run(
      Effect.gen(function* () {
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        return [
          yield* repo.findByExternal("discord_channel", "chan-1"),
          yield* repo.findByExternal("discord_channel", "nope"),
        ] as const;
      }),
    );
    expect(hit?.projectId).toBe("p1");
    expect(miss).toBeUndefined();
  });

  it("setDefaultResponse keeps at most one default per project", async () => {
    const list = await run(
      Effect.gen(function* () {
        const repo = yield* ProjectSourceRepository;
        yield* repo.insert(source());
        yield* repo.insert(source({ id: "s2", externalId: "chan-2" }));
        yield* repo.setDefaultResponse("p1", "s1");
        yield* repo.setDefaultResponse("p1", "s2");
        return yield* repo.listByProject("p1");
      }),
    );
    expect(list.filter((s) => s.isDefaultResponse).map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("TicketRepository fake", () => {
  it("claim is atomic: second claim loses", async () => {
    const [first, second] = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        const a = yield* repo.claim("t1", "w1", T0);
        const b = yield* Effect.flip(repo.claim("t1", "w1", T0));
        return [a, b] as const;
      }),
    );
    expect(first.status).toBe("in_progress");
    expect(second._tag).toBe("ClaimConflict");
  });

  it("appendEvent bumps lastActivityAt", async () => {
    const t = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket());
        yield* repo.appendEvent({
          id: "e1",
          ticketId: "t1",
          type: "comment",
          actor: "worker",
          actorId: "w1",
          body: "hi",
          payload: null,
          createdAt: "2026-11-04T00:05:00.000Z",
        });
        return yield* repo.get("t1");
      }),
    );
    expect(t.lastActivityAt).toBe("2026-11-04T00:05:00.000Z");
  });

  it("listAssigned returns only the worker's assigned tickets, oldest first", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ id: "b", assignedAt: "2026-11-04T00:02:00.000Z" }));
        yield* repo.insert(ticket({ id: "a", assignedAt: "2026-11-04T00:01:00.000Z" }));
        yield* repo.insert(ticket({ id: "c", workerId: "other" }));
        yield* repo.insert(ticket({ id: "d", status: "in_progress" }));
        return (yield* repo.listAssigned("w1")).map((t) => t.id);
      }),
    );
    expect(ids).toEqual(["a", "b"]);
  });
});
