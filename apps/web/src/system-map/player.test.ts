// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Story } from "./feed.ts";
import { DURATION_MS, FLASH_MS, usePlayer } from "./player.ts";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
});
afterEach(() => vi.useRealTimers());

const story = (ticketId: string, label = "ticket_claim"): Story => ({
  ticketId,
  steps: [
    { type: "flash", module: "mcp" },
    { type: "travel", from: "worker:w1", to: "coordinator", packet: { kind: "call", label } },
    { type: "status", ticketId, status: "in_progress" },
  ],
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("usePlayer", () => {
  it("lights a module, moves a packet, then sets the status, and goes idle", async () => {
    const { result, unmount } = renderHook(() => usePlayer(() => true, false));
    act(() => result.current.play(story("t1")));
    await advance(20);
    expect(result.current.isFlashing("mcp")).toBe(true);
    expect(result.current.isFlashing("jev")).toBe(false);
    await advance(400);
    expect(result.current.trips.map((t) => t.packet)).toEqual([
      { kind: "call", label: "ticket_claim" },
    ]);
    expect(result.current.shown.get("t1")).toBeUndefined();
    await advance(DURATION_MS.call + FLASH_MS);
    expect(result.current.trips).toEqual([]);
    expect(result.current.shown.get("t1")).toBe("in_progress");
    expect(result.current.isFlashing("mcp")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("plays one ticket's stories in order and different tickets side by side", async () => {
    const { result, unmount } = renderHook(() => usePlayer(() => true, false));
    act(() => {
      result.current.play(story("t1", "first"));
      result.current.play(story("t1", "second"));
      result.current.play(story("t2", "other"));
    });
    await advance(400);
    expect(
      result.current.trips.map((t) => t.packet.kind === "call" && t.packet.label).sort(),
    ).toEqual(["first", "other"]);
    await advance(DURATION_MS.call + 400);
    expect(result.current.trips.map((t) => t.packet.kind === "call" && t.packet.label)).toEqual([
      "second",
    ]);
    await advance(2000);
    act(() => result.current.play(story("t1", "third")));
    await advance(400);
    expect(result.current.trips).toHaveLength(1);
    unmount();
  });

  it("skips travel it cannot draw, and all motion when motion is reduced", async () => {
    const blocked = renderHook(() => usePlayer(() => false, false));
    act(() => blocked.result.current.play(story("t1")));
    await advance(400);
    expect(blocked.result.current.trips).toEqual([]);
    expect(blocked.result.current.shown.get("t1")).toBe("in_progress");
    blocked.unmount();

    const still = renderHook(() => usePlayer(() => true, true));
    act(() => still.result.current.play(story("t2")));
    await advance(0);
    expect(still.result.current.shown.get("t2")).toBe("in_progress");
    still.unmount();
  });

  it("settles statuses from a baseline read", () => {
    const { result, unmount } = renderHook(() => usePlayer(() => true, false));
    act(() => result.current.settle([["t1", "assigned"]]));
    expect(result.current.shown.get("t1")).toBe("assigned");
    unmount();
  });

  it("cancels its animation frame when unmounted mid-flight", async () => {
    const { result, unmount } = renderHook(() => usePlayer(() => true, false));
    act(() => result.current.play(story("t1")));
    await advance(400);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
