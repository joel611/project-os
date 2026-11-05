import { TICKET_STATUSES, type Ticket } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  checkSource,
  detectSource,
  relativeTime,
  sourceUrl,
  splitTickets,
  STATUS,
} from "./model.ts";

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

describe("detectSource", () => {
  it.each([
    ["https://github.com/acme/web", "github_repo", "acme/web"],
    ["https://github.com/acme/web.git", "github_repo", "acme/web"],
    ["https://github.com/acme/web/tree/main/src", "github_repo", "acme/web"],
    ["acme/web", "github_repo", "acme/web"],
    ["Acme/Web", "github_repo", "acme/web"],
    [
      "https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing",
      "google_drive_folder",
      "1AbCdEfGhIjK",
    ],
    [
      "https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjK",
      "google_drive_folder",
      "1AbCdEfGhIjK",
    ],
    ["drive.google.com/drive/folders/1AbCdEfGhIjK", "google_drive_folder", "1AbCdEfGhIjK"],
    ["1AbCdEfGhIjK", "google_drive_folder", "1AbCdEfGhIjK"],
  ])("%s -> %s", (raw, type, id) => {
    expect(detectSource(raw)).toMatchObject({ type, externalId: id });
  });

  it.each(["", "not a repo", "short"])("rejects %j", (raw) => {
    expect(detectSource(raw)).toBeNull();
  });
});

describe("checkSource", () => {
  const existing = [{ type: "github_repo", externalId: "acme/web" }];

  it("accepts a new source", () => {
    expect(checkSource("acme/api", existing).kind).toBe("ok");
  });

  it("flags a source already on the project, case-insensitively", () => {
    expect(checkSource("https://github.com/ACME/Web", existing)).toMatchObject({
      kind: "duplicate",
      input: { externalId: "acme/web" },
    });
  });

  it("only collides within the same source type", () => {
    const same = [{ type: "github_repo", externalId: "1AbCdEfGhIjK" }];
    expect(checkSource("1AbCdEfGhIjK", same).kind).toBe("ok");
  });

  it("flags junk", () => {
    expect(checkSource("nope", [])).toEqual({ kind: "invalid" });
  });
});

describe("sourceUrl", () => {
  it.each([
    [{ type: "github_repo", externalId: "a/b" }, "https://github.com/a/b"],
    [
      { type: "google_drive_folder", externalId: "xyz" },
      "https://drive.google.com/drive/folders/xyz",
    ],
    [{ type: "discord_channel", externalId: "1" }, null],
  ])("%j", (s, url) => {
    expect(sourceUrl(s)).toBe(url);
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
