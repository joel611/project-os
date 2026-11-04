import { Clock } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { LocalLive } from "./index.ts";

describe("LocalLive", () => {
  it("satisfies the Clock port", async () => {
    const program = Effect.gen(function* () {
      const clock = yield* Clock;
      return yield* clock.now;
    });
    const now = await Effect.runPromise(program.pipe(Effect.provide(LocalLive)));
    expect(now).toBeInstanceOf(Date);
  });
});
