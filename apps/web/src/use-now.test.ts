// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useNow } from "./use-now.ts";

afterEach(() => vi.useRealTimers());

it("ticks every 15 seconds, so relative times move without new data", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
  const { result, unmount } = renderHook(() => useNow());
  expect(result.current.toISOString()).toBe("2026-11-05T12:00:00.000Z");
  act(() => vi.advanceTimersByTime(15_000));
  expect(result.current.toISOString()).toBe("2026-11-05T12:00:15.000Z");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
