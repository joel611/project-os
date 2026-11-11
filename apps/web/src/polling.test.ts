import { describe, expect, it } from "vite-plus/test";
import {
  activityInterval,
  LIVE_MS,
  SLOW_MS,
  ticketDetailInterval,
  ticketListInterval,
} from "./polling.ts";

describe("polling cadence", () => {
  it("polls tickets fast only while one is unfinished", () => {
    expect(ticketListInterval(undefined)).toBe(LIVE_MS);
    expect(ticketListInterval([{ status: "completed" }, { status: "in_progress" }])).toBe(LIVE_MS);
    expect(ticketListInterval([{ status: "completed" }, { status: "failed" }])).toBe(SLOW_MS);
    expect(ticketListInterval([])).toBe(SLOW_MS);
  });

  it("stops polling a finished ticket", () => {
    expect(ticketDetailInterval(undefined)).toBe(LIVE_MS);
    expect(ticketDetailInterval({ status: "assigned" })).toBe(LIVE_MS);
    expect(ticketDetailInterval({ status: "cancelled" })).toBe(false);
  });

  it("backs the map off while quiet and caps it", () => {
    expect([0, 1, 2, 3, 9].map(activityInterval)).toEqual([2000, 4000, 8000, 10000, 10000]);
  });
});
