import { envNumber } from "./index.ts";

const MINUTE_MS = 60_000;

/**
 * Channel Digest timings (`digestChannels`), the same for every project. Env values are
 * minutes / days. Whether a project is digested, and whether it posts what it saved, are
 * project settings in the dashboard.
 */
export const channelDigestConfig = (
  source: Readonly<Record<string, string | undefined>> = process.env,
) => ({
  quietMs: envNumber("CHANNEL_DIGEST_QUIET_MIN", 30, source) * MINUTE_MS,
  maxWaitMs: envNumber("CHANNEL_DIGEST_MAX_WAIT_MIN", 360, source) * MINUTE_MS,
  retentionMs: envNumber("CHANNEL_DIGEST_RETENTION_DAYS", 7, source) * 24 * 60 * MINUTE_MS,
  maxMessages: envNumber("CHANNEL_DIGEST_MAX_MESSAGES", 200, source),
  retryAfterMs: envNumber("CHANNEL_DIGEST_RETRY_MIN", 10, source) * MINUTE_MS,
});
