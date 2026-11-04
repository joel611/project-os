import { Clock } from "@project-os/core";
import { Effect, Layer } from "effect";

export const SystemClockLive = Layer.succeed(Clock, {
  now: Effect.sync(() => new Date()),
});
