import { TICKET_STATUSES, type Ticket } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { checkLines, parseSource, sourceUrl, relativeTime, splitTickets, STATUS } from "./model.ts";

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

  it("lowercases github ids so case variants collide", () => {
    expect(parseSource("github_repo", "Acme/Web")?.externalId).toBe("acme/web");
  });

  it("rejects junk", () => {
    expect(parseSource("github_repo", "not a repo")).toBeNull();
    expect(parseSource("google_drive_folder", "short")).toBeNull();
  });
});

describe("checkLines", () => {
  const existing = [{ type: "github_repo", externalId: "acme/web" }];

  it("accepts several repos, one per line, and skips blank lines", () => {
    const r = checkLines("github_repo", "acme/api\n\nhttps://github.com/acme/docs", existing);
    expect(r.map((c) => c.kind)).toEqual(["ok", "ok"]);
  });

  it("flags a source already on the project, case-insensitively", () => {
    const [c] = checkLines("github_repo", "https://github.com/ACME/Web", existing);
    expect(c).toMatchObject({ kind: "duplicate", in: "project" });
  });

  it("flags a repeat within the same paste but keeps the first", () => {
    const r = checkLines("github_repo", "acme/api\nacme/api", existing);
    expect(r.map((c) => c.kind)).toEqual(["ok", "duplicate"]);
    expect(r[1]).toMatchObject({ in: "paste" });
  });

  it("only compares within the same source type", () => {
    const r = checkLines("google_drive_folder", "acme/web1234567", existing);
    expect(r[0]?.kind).toBe("invalid");
    const d = checkLines("google_drive_folder", "1AbCdEfGhIjK", [
      { type: "github_repo", externalId: "1AbCdEfGhIjK" },
    ]);
    expect(d[0]?.kind).toBe("ok");
  });

  it("flags junk lines", () => {
    expect(checkLines("github_repo", "nope", [])[0]).toEqual({ kind: "invalid", raw: "nope" });
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
