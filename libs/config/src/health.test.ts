import { afterEach, describe, expect, it } from "vite-plus/test";
import { healthConfig } from "./health.ts";

afterEach(() => {
  delete process.env.HEALTH_UNPICKED_MIN;
});

describe("healthConfig", () => {
  it("defaults to the architecture thresholds", () => {
    expect(healthConfig()).toEqual({
      workerStaleMs: 900_000,
      unpickedMs: 1_800_000,
      followUpMs: 900_000,
      inactivityFailMs: 1_800_000,
      sweepEveryMs: 60_000,
      sharedWorkerMaxTickets: 1,
      auditRetentionMs: 7_776_000_000,
    });
  });

  it("reads overrides from env", () => {
    process.env.HEALTH_UNPICKED_MIN = "5";
    expect(healthConfig().unpickedMs).toBe(300_000);
  });
});
