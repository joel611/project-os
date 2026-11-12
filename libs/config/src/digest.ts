import { envBool, envNumber } from "./index.ts";

const MINUTE_MS = 60_000;

/**
 * Channel Digest settings (`digestChannels`). Env values are minutes / days. On by default:
 * set `CHANNEL_DIGEST=false` to stop keeping project channel messages and digesting them.
 */
export const channelDigestConfig = (
  source: Readonly<Record<string, string | undefined>> = process.env,
) => ({
  enabled: envBool("CHANNEL_DIGEST", true, source),
  quietMs: envNumber("CHANNEL_DIGEST_QUIET_MIN", 30, source) * MINUTE_MS,
  maxWaitMs: envNumber("CHANNEL_DIGEST_MAX_WAIT_MIN", 360, source) * MINUTE_MS,
  retentionMs: envNumber("CHANNEL_DIGEST_RETENTION_DAYS", 7, source) * 24 * 60 * MINUTE_MS,
  maxMessages: envNumber("CHANNEL_DIGEST_MAX_MESSAGES", 200, source),
  /** Post what was saved in the project channel. Off: memory fills in silently. */
  notify: envBool("CHANNEL_DIGEST_NOTIFY", false, source),
  retryAfterMs: envNumber("CHANNEL_DIGEST_RETRY_MIN", 10, source) * MINUTE_MS,
});
