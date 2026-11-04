import { healthSweep, Scheduler, type HealthThresholds } from "@project-os/core";
import { Effect } from "effect";

type Sweep = ReturnType<typeof healthSweep>;

/**
 * Schedules the health sweep via the `Scheduler` port. Captures the caller's services so the
 * recurring task runs with the same repositories and clock. Returns the stop effect.
 */
export const startHealthSweep = (config: HealthThresholds & { readonly sweepEveryMs: number }) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    const context = yield* Effect.context<Effect.Services<Sweep>>();
    return yield* scheduler.every(
      "health-sweep",
      config.sweepEveryMs,
      healthSweep(config).pipe(Effect.provideContext(context), Effect.asVoid),
    );
  });
