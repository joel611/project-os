import { describe, expect, it } from "vite-plus/test";
import { channelDigestConfig } from "./digest.ts";

describe("channelDigestConfig", () => {
  it("is on by default: digest after 30 quiet minutes or 6 hours, keep 7 days, silently", () => {
    expect(channelDigestConfig({})).toEqual({
      enabled: true,
      quietMs: 1_800_000,
      maxWaitMs: 21_600_000,
      retentionMs: 604_800_000,
      maxMessages: 200,
      notify: false,
      retryAfterMs: 600_000,
    });
  });

  it("reads overrides", () => {
    const config = channelDigestConfig({ CHANNEL_DIGEST: "false", CHANNEL_DIGEST_QUIET_MIN: "5" });
    expect(config.enabled).toBe(false);
    expect(config.quietMs).toBe(300_000);
  });
});
