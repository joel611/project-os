import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeRuntimeErrorLogger, runtimeErrorSecrets } from "./runtime-errors.ts";

describe("runtimeErrorSecrets", () => {
  it("collects the secrets that are set and skips empty ones", () => {
    expect(
      runtimeErrorSecrets({
        BETTER_AUTH_SECRET: "a",
        COORDINATOR_SERVICE_TOKEN: "",
        ADMIN_MCP_TOKEN: "c",
        OTHER: "d",
      }),
    ).toEqual(["a", "c"]);
    expect(runtimeErrorSecrets({})).toEqual([]);
  });
});

describe("makeRuntimeErrorLogger", () => {
  it("writes route errors and job failures through the runtime, keeping the work alive", async () => {
    const runs: Array<Effect.Effect<unknown, never, never>> = [];
    const kept: Array<Promise<unknown>> = [];
    const log = vi.fn();
    const logger = makeRuntimeErrorLogger<never>({
      run: async (effect) => void runs.push(effect),
      secrets: ["s3cret-value"],
      keepAlive: (work) => void kept.push(work),
      log,
    });
    logger.route({ where: "GET /x", error: new Error("boom") });
    await logger.job("health_sweep", "health sweep")(new Error("sweep"));
    expect(runs).toHaveLength(2);
    expect(kept).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("http error in GET /x", expect.any(Error));
    expect(log).toHaveBeenCalledWith("health_sweep error in health sweep", expect.any(Error));
  });

  it("drops a failure to log, and logs to the console by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = makeRuntimeErrorLogger<never>({
      run: () => Promise.reject(new Error("db down")),
      secrets: [],
    });
    await expect(logger.job("channel_digest", "channel digest")("x")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("channel_digest error in channel digest", "x");
    spy.mockRestore();
  });
});
