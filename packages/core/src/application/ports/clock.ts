import { Context, type Effect } from "effect";

/**
 * Placeholder port proving the pattern: core declares the interface,
 * a provider package supplies a Layer. The remaining ports land in #8.
 */
export class Clock extends Context.Service<
  Clock,
  {
    readonly now: Effect.Effect<Date>;
  }
>()("@project-os/core/Clock") {}
