import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { makeTimerScheduler } from "./scheduler.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("timer Scheduler", () => {
  it("runs the task every interval until stopped", async () => {
    let runs = 0;
    const scheduler = makeTimerScheduler();
    const stop = await Effect.runPromise(
      scheduler.every(
        "tick",
        5,
        Effect.sync(() => void runs++),
      ),
    );
    await sleep(40);
    expect(runs).toBeGreaterThanOrEqual(2);
    await Effect.runPromise(stop);
    const after = runs;
    await sleep(30);
    expect(runs).toBe(after);
  });
});
