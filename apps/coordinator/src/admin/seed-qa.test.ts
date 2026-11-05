import {
  type IdGenerator,
  MemoryRepository,
  TicketRepository,
  TERMINAL_STATUSES,
} from "@project-os/core";
import { makeTestLayer } from "@project-os/testing";
import { Effect, type Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { seedQaData } from "./seed-qa.ts";

type Env = TicketRepository | MemoryRepository | IdGenerator;

const run = <A, E>(program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(
    Effect.provide(program.pipe(Effect.orDie), makeTestLayer().layer as Layer.Layer<Env>),
  );

describe("seedQaData", () => {
  it("seeds every ticket status, events, and linked memory", async () => {
    const { first, tickets, events, memory } = await run(
      Effect.gen(function* () {
        const first = yield* seedQaData("p1");
        const repo = yield* TicketRepository;
        const tickets = yield* repo.listByStatus([
          "open",
          "assigned",
          "in_progress",
          "blocked",
          "completed",
          "failed",
          "cancelled",
        ]);
        const events = yield* repo.listEvents(tickets.find((t) => t.status === "in_progress")!.id);
        const memory = yield* (yield* MemoryRepository).list("p1");
        return { first, tickets, events, memory };
      }),
    );
    expect(first).toEqual({ tickets: 7, memory: 8 });
    expect(new Set(tickets.map((t) => t.status)).size).toBe(7);
    for (const t of tickets) {
      expect(t.completedAt !== null).toBe(TERMINAL_STATUSES.includes(t.status));
    }
    expect(events.length).toBeGreaterThan(3);
    expect(new Set(memory.map((m) => m.type)).size).toBe(6);
    const ticketIds = new Set(tickets.map((t) => t.id));
    expect(memory.filter((m) => m.ticketId !== null).length).toBe(4);
    for (const m of memory) if (m.ticketId) expect(ticketIds.has(m.ticketId)).toBe(true);
  });

  it("is idempotent", async () => {
    const second = await run(
      Effect.gen(function* () {
        yield* seedQaData("p1");
        return yield* seedQaData("p1");
      }),
    );
    expect(second).toEqual({ tickets: 0, memory: 0 });
  });
});
