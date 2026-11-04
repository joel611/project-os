import { Clock } from "@project-os/core";
import { Effect, Layer } from "effect";

/** Fixed clock for deterministic tests. In-memory fakes for every port land in #8. */
export const fixedClock = (date: Date) => Layer.succeed(Clock, { now: Effect.succeed(date) });
