import { envNumber } from "./index.ts";

const MINUTE_MS = 60_000;

/** Health sweep thresholds and cadence in ms (§5.5). Env values are minutes / seconds. */
export const healthConfig = () => ({
  workerStaleMs: envNumber("HEALTH_WORKER_STALE_MIN", 15) * MINUTE_MS,
  unpickedMs: envNumber("HEALTH_UNPICKED_MIN", 30) * MINUTE_MS,
  followUpMs: envNumber("HEALTH_FOLLOW_UP_MIN", 15) * MINUTE_MS,
  inactivityFailMs: envNumber("HEALTH_INACTIVITY_FAIL_MIN", 30) * MINUTE_MS,
  sweepEveryMs: envNumber("HEALTH_SWEEP_EVERY_SEC", 60) * 1000,
});
