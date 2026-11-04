import { Layer } from "effect";
import { SystemClockLive } from "./clock.ts";

export { SystemClockLive };

/** Every core port for the local target (Bun + bun:sqlite). Grows in #10. */
export const LocalLive = Layer.mergeAll(SystemClockLive);
