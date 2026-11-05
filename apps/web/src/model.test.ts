import { TICKET_STATUSES, type Ticket } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { parseSource, relativeTime, splitTickets, STATUS } from "./model.ts";

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

describe("parseSource", () => {
  it.each([
    ["https://github.com/acme/web", "acme/web"],
    ["https://github.com/acme/web.git", "acme/web"],
    ["https://github.com/acme/web/tree/main/src", "acme/web"],
    ["acme/web", "acme/web"],
  ])("normalizes github %s", (raw, id) => {
    expect(parseSource("github_repo", raw)?.externalId).toBe(id);
  });

  it.each([
    ["https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing", "1AbCdEfGhIjK"],
    ["https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjK", "1AbCdEfGhIjK"],
    ["1AbCdEfGhIjK", "1AbCdEfGhIjK"],
  ])("normalizes drive %s", (raw, id) => {
    expect(parseSource("google_drive_folder", raw)?.externalId).toBe(id);
  });

  it("rejects junk", () => {
    expect(parseSource("github_repo", "not a repo")).toBeNull();
    expect(parseSource("google_drive_folder", "short")).toBeNull();
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
