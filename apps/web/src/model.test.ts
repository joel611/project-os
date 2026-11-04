import { TICKET_STATUSES, type Ticket } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatRoute, parseRoute, relativeTime, splitTickets, STATUS } from "./model.ts";

const ticket = (id: string, status: Ticket["status"], lastActivityAt: string): Ticket => ({
  id,
  projectId: "p1",
  status,
  title: id,
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: null,
  workerId: null,
  result: null,
  error: null,
  createdAt: lastActivityAt,
  assignedAt: null,
  startedAt: null,
  lastActivityAt,
  completedAt: null,
  updatedAt: lastActivityAt,
});

describe("STATUS", () => {
  it("marks exactly completed, failed, and cancelled as terminal", () => {
    expect(TICKET_STATUSES.filter((s) => STATUS[s].terminal)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});

describe("splitTickets", () => {
  it("separates live from finished work, most recent activity first", () => {
    const { active, done } = splitTickets([
      ticket("old-open", "open", "2026-11-01T00:00:00Z"),
      ticket("done", "completed", "2026-11-02T00:00:00Z"),
      ticket("new-running", "in_progress", "2026-11-03T00:00:00Z"),
      ticket("failed", "failed", "2026-11-04T00:00:00Z"),
    ]);
    expect(active.map((t) => t.id)).toEqual(["new-running", "old-open"]);
    expect(done.map((t) => t.id)).toEqual(["failed", "done"]);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it.each([
    ["2026-11-05T11:59:30Z", "just now"],
    ["2026-11-05T11:55:00Z", "5m ago"],
    ["2026-11-05T09:00:00Z", "3h ago"],
    ["2026-11-03T12:00:00Z", "2d ago"],
  ])("%s → %s", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe("routes", () => {
  it.each([
    ["", { view: "home" }],
    ["#/", { view: "home" }],
    ["#/nonsense", { view: "home" }],
    ["#/p/a%2Fb", { view: "project", projectId: "a/b", ticketId: null }],
    ["#/p/p1/t/t%201", { view: "project", projectId: "p1", ticketId: "t 1" }],
  ] as const)("parses %j", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each([
    { view: "home" },
    { view: "project", projectId: "a/b", ticketId: null },
    { view: "project", projectId: "p1", ticketId: "t 1" },
  ] as const)("round-trips %j", (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });
});
