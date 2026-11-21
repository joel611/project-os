import { envNumber } from "./index.ts";

const MINUTE_MS = 60_000;

/** Health sweep thresholds and cadence in ms (§5.5). Env values are minutes / seconds. */
export const healthConfig = () => ({
  workerStaleMs: envNumber("HEALTH_WORKER_STALE_MIN", 15) * MINUTE_MS,
  unpickedMs: envNumber("HEALTH_UNPICKED_MIN", 30) * MINUTE_MS,
  followUpMs: envNumber("HEALTH_FOLLOW_UP_MIN", 15) * MINUTE_MS,
  inactivityFailMs: envNumber("HEALTH_INACTIVITY_FAIL_MIN", 30) * MINUTE_MS,
  sweepEveryMs: envNumber("HEALTH_SWEEP_EVERY_SEC", 60) * 1000,
  /** Tickets one shared device holds at once before the next goes elsewhere. */
  sharedWorkerMaxTickets: envNumber("SHARED_WORKER_MAX_TICKETS", 1),
  /** Audit log entries older than this are deleted by the sweep. */
  auditRetentionMs: envNumber("AUDIT_RETENTION_DAYS", 90) * 24 * 60 * MINUTE_MS,
  /** Run transcripts older than this are deleted by the sweep. */
  runLogRetentionMs: envNumber("RUN_LOG_RETENTION_DAYS", 30) * 24 * 60 * MINUTE_MS,
});
