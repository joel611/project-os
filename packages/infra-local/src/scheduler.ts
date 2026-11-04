import type { Scheduler } from "@project-os/core";
import { Effect } from "effect";

/** `setInterval` scheduler. `every` returns an effect that clears the timer. */
export const makeTimerScheduler = (): typeof Scheduler.Service => ({
  every: (_name, everyMs, task) =>
    Effect.sync(() => {
      const timer = setInterval(() => void Effect.runFork(task), everyMs);
      return Effect.sync(() => clearInterval(timer));
    }),
});
