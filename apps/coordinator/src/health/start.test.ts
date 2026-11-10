import {
  Clock,
  IdGenerator,
  KeyValueStore,
  Scheduler,
  TicketRepository,
  WorkerLauncher,
  WorkerRepository,
  type Ticket,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { startHealthSweep } from "./start.ts";

const config = {
  workerStaleMs: 1,
  unpickedMs: 1,
  followUpMs: 1,
  inactivityFailMs: 1,
  sweepEveryMs: 60_000,
};

describe("startHealthSweep", () => {
  it("schedules the sweep and runs it with the caller's services", async () => {
    const queried: string[][] = [];
    let scheduled: { name: string; everyMs: number; task: Effect.Effect<void> } | undefined;
    let stopped = false;

    const layer = Layer.mergeAll(
      Layer.succeed(Clock, { now: Effect.succeed(new Date("2026-11-04T00:00:00.000Z")) }),
      Layer.succeed(IdGenerator, { next: Effect.succeed("id") }),
      Layer.succeed(KeyValueStore, {} as never),
      Layer.succeed(WorkerRepository, { list: Effect.succeed([]) } as never),
      Layer.succeed(WorkerLauncher, { pool: Effect.succeed([]), launch: () => Effect.void }),
      Layer.succeed(TicketRepository, {
        listByStatus: (statuses: ReadonlyArray<string>) => {
          queried.push([...statuses]);
          return Effect.succeed<ReadonlyArray<Ticket>>([]);
        },
      } as never),
      Layer.succeed(Scheduler, {
        every: (name, everyMs, task) =>
          Effect.sync(() => {
            scheduled = { name, everyMs, task };
            return Effect.sync(() => {
              stopped = true;
            });
          }),
      }),
    );

    const stop = await Effect.runPromise(startHealthSweep(config).pipe(Effect.provide(layer)));
    expect(scheduled).toMatchObject({ name: "health-sweep", everyMs: 60_000 });

    await Effect.runPromise(scheduled!.task);
    expect(queried).toEqual([["open"], ["assigned"], ["in_progress"]]);

    await Effect.runPromise(stop);
    expect(stopped).toBe(true);
  });
});
