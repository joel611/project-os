import { afterEach, expect, it, vi } from "vite-plus/test";
import { watchRunStop } from "./run-stop.ts";

afterEach(() => vi.useRealTimers());

it("retries after an outage and never overlaps polls or acts on a late result after close", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<boolean>();
  const fetchStop = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(false)
    .mockReturnValueOnce(pending.promise);
  const stop = vi.fn();
  const close = watchRunStop({
    mcpUrl: "http://localhost/mcp",
    ticketId: "t/1",
    runId: "r 1",
    secret: "token",
    fetchStop,
    stop,
    intervalMs: 10,
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(fetchStop).toHaveBeenCalledTimes(3);
  expect(fetchStop).toHaveBeenLastCalledWith(
    "http://localhost/tickets/t%2F1/runs/r%201/signal",
    "token",
    expect.any(AbortSignal),
  );
  close();
  pending.resolve(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(stop).not.toHaveBeenCalled();
  expect(fetchStop).toHaveBeenCalledTimes(3);
});
