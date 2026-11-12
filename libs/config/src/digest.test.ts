import { describe, expect, it } from "vite-plus/test";
import { channelDigestConfig } from "./digest.ts";

describe("channelDigestConfig", () => {
  it("digests after 30 quiet minutes or 6 hours, and keeps waiting messages 7 days", () => {
    expect(channelDigestConfig({})).toEqual({
      quietMs: 1_800_000,
      maxWaitMs: 21_600_000,
      retentionMs: 604_800_000,
      maxMessages: 200,
      retryAfterMs: 600_000,
    });
  });

  it("reads process.env by default", () => {
    process.env.CHANNEL_DIGEST_MAX_MESSAGES = "50";
    expect(channelDigestConfig().maxMessages).toBe(50);
    delete process.env.CHANNEL_DIGEST_MAX_MESSAGES;
  });

  it("reads overrides", () => {
    expect(channelDigestConfig({ CHANNEL_DIGEST_QUIET_MIN: "5" }).quietMs).toBe(300_000);
  });
});
