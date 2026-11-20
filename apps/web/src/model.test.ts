import { TICKET_STATUSES, type Ticket } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  checkSource,
  formatBytes,
  groupSources,
  groupWorkers,
  assignTargets,
  hasAttachments,
  isShownInline,
  lastSeen,
  newestFirst,
  workerGroup,
  workerName,
  relativeTime,
  confirmPhrase,
  removalNote,
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
  requester: null,
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

describe("newestFirst", () => {
  it("orders events newest first and keeps feed order for equal timestamps reversed", () => {
    const ev = (id: string, createdAt: string) => ({ id, createdAt });
    const out = newestFirst([
      ev("a", "2026-01-01T00:00:00Z"),
      ev("b", "2026-01-03T00:00:00Z"),
      ev("c", "2026-01-02T00:00:00Z"),
      ev("d", "2026-01-02T00:00:00Z"),
    ]);
    expect(out.map((e) => e.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("does not mutate its input", () => {
    const input = [{ createdAt: "2026-01-01T00:00:00Z" }, { createdAt: "2026-01-02T00:00:00Z" }];
    newestFirst(input);
    expect(input[0]?.createdAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("checkSource", () => {
  const existing = [{ type: "github_repo", externalId: "acme/web", alias: "web" }];
  const check = (link: string, alias = "api", description?: string) =>
    checkSource({ link, alias, ...(description === undefined ? {} : { description }) }, existing);

  it("accepts a new source with its normalized alias and trimmed description", () => {
    expect(check("acme/api", " Design Docs ", "  specs  ")).toEqual({
      kind: "ok",
      input: {
        type: "github_repo",
        externalId: "acme/api",
        name: "acme/api",
        alias: "design-docs",
        description: "specs",
      },
    });
  });

  it("drops a blank description", () => {
    expect(check("acme/api", "api", "   ")).toMatchObject({ kind: "ok", input: { alias: "api" } });
    const result = check("acme/api", "api", "   ");
    expect(result.kind === "ok" && "description" in result.input).toBe(false);
  });

  it("flags a source already on the project, case-insensitively", () => {
    expect(check("https://github.com/ACME/Web")).toMatchObject({
      kind: "duplicate",
      input: { externalId: "acme/web" },
    });
  });

  it("only collides within the same source type", () => {
    const same = [{ type: "github_repo", externalId: "1AbCdEfGhIjK", alias: "x" }];
    expect(checkSource({ link: "1AbCdEfGhIjK", alias: "drive" }, same).kind).toBe("ok");
  });

  it.each(["", "a--b", "-a", "a b!", "x".repeat(41)])("rejects alias %j", (alias) => {
    expect(check("acme/api", alias).kind).toBe("bad_alias");
  });

  it("rejects a link that is neither a repo nor a Drive folder", () => {
    expect(check("not a link").kind).toBe("invalid");
  });

  it("rejects an alias another source in the project uses", () => {
    expect(check("acme/api", "WEB")).toEqual({ kind: "alias_taken", alias: "web" });
  });
});

describe("groupSources", () => {
  it("groups by provider in page order, keeping order within a group", () => {
    const groups = groupSources([
      { type: "discord_channel", alias: "chat" },
      { type: "github_repo", alias: "web" },
      { type: "google_drive_folder", alias: "docs" },
      { type: "github_repo", alias: "api" },
    ]);
    expect(groups.map((g) => [g.provider, g.sources.map((s) => s.alias)])).toEqual([
      ["github", ["web", "api"]],
      ["google_drive", ["docs"]],
      ["discord", ["chat"]],
    ]);
  });

  it("puts a type it doesn't know under other, last", () => {
    const groups = groupSources([
      { type: "notion_page", alias: "wiki" },
      { type: "toString", alias: "odd" },
      { type: "email_address", alias: "inbox" },
    ]);
    expect(groups.map((g) => [g.provider, g.sources.length])).toEqual([
      ["email", 1],
      ["other", 2],
    ]);
  });

  it("returns no groups for no sources", () => {
    expect(groupSources([])).toEqual([]);
  });
});

describe("confirmPhrase", () => {
  it.each([
    [{ type: "github_repo", alias: "web" }, "remove github"],
    [{ type: "google_drive_folder", alias: "docs" }, "remove drive"],
    [{ type: "discord_channel", alias: "chat" }, "remove chat"],
  ])("%j", (s, phrase) => {
    expect(confirmPhrase(s)).toBe(phrase);
  });
});

describe("removalNote", () => {
  it("says what a removed source stops doing", () => {
    expect(removalNote({ type: "github_repo", isDefaultResponse: false })).toBe(
      "Workers will no longer see it.",
    );
    expect(removalNote({ type: "discord_channel", isDefaultResponse: true })).toBe(
      "Workers will no longer see it, and its messages will stop reaching this project." +
        " It is the reply channel, so the project will have none until you link another.",
    );
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

describe("workers", () => {
  const T = "2026-11-04T00:00:00.000Z";
  const w = (
    id: string,
    over: { registered?: boolean; ownerId?: string; name?: string; online?: boolean } = {},
  ) => ({
    id,
    workerType: "local" as const,
    ownerChannelType: over.ownerId ? ("discord" as const) : null,
    ownerId: over.ownerId ?? null,
    registered: over.registered ?? true,
    name: over.name ?? null,
    currentTicketId: null,
    lastSeenAt: T,
    createdAt: T,
    status: over.online === false ? ("offline" as const) : ("online" as const),
  });

  it("tells shared, personal and sandbox workers apart, and names them", () => {
    expect(workerGroup(w("shared-1"))).toBe("shared");
    expect(workerGroup(w("local-1", { ownerId: "u1" }))).toBe("personal");
    expect(workerGroup(w("daytona-t1", { registered: false }))).toBe("sandbox");
    expect(workerName(w("shared-1", { name: "build-box" }))).toBe("build-box");
    expect(workerName(w("shared-1"))).toBe("shared-1");
  });

  it("reads a worker's last heartbeat, or never before its first", () => {
    const now = new Date("2026-11-04T00:05:00.000Z");
    expect(lastSeen({ lastSeenAt: T }, now)).toBe("5m ago");
    expect(lastSeen({ lastSeenAt: new Date(0).toISOString() }, now)).toBe("never");
  });

  it("groups online first then by name, and keeps only online sandbox sessions", () => {
    const groups = groupWorkers([
      w("shared-b", { name: "b" }),
      w("shared-z", { name: "a", online: false }),
      w("shared-a", { name: "c" }),
      w("local-1", { ownerId: "u1" }),
      w("daytona-1", { registered: false }),
      w("daytona-2", { registered: false, online: false }),
    ]);
    expect(groups.shared.map((x) => x.id)).toEqual(["shared-b", "shared-a", "shared-z"]);
    expect(groups.personal.map((x) => x.id)).toEqual(["local-1"]);
    expect(groups.sandbox.map((x) => x.id)).toEqual(["daytona-1"]);
  });

  it("offers registered devices other than the ticket's worker as assign targets", () => {
    const targets = assignTargets(
      [
        w("local-1", { ownerId: "u1" }),
        w("shared-a", { name: "a", online: false }),
        w("shared-b", { name: "b" }),
        w("daytona-1", { registered: false }),
      ],
      "shared-b",
    );
    expect(targets.map((x) => x.id)).toEqual(["shared-a", "local-1"]);
  });
});

describe("hasAttachments", () => {
  const ref = { id: "a1", filename: "x.png", contentType: "image/png", size: 1 };

  it("is true when a created or follow_up event carries files", () => {
    expect(hasAttachments([{ payload: null }, { payload: { attachments: [ref] } }])).toBe(true);
  });

  it("is false for text-only tickets and malformed payloads", () => {
    expect(hasAttachments([])).toBe(false);
    expect(
      hasAttachments([
        { payload: null },
        { payload: "text" },
        { payload: { sender: { id: "u1" } } },
        { payload: { attachments: [] } },
        { payload: { attachments: "no" } },
      ]),
    ).toBe(false);
  });
});

describe("isShownInline", () => {
  it("draws plain raster pictures only", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(isShownInline(type)).toBe(true);
    }
    for (const type of ["image/svg+xml", "video/mp4", "application/pdf", "image/png2", null]) {
      expect(isShownInline(type)).toBe(false);
    }
  });
});

describe("formatBytes", () => {
  it("scales to the largest unit under 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(3.25 * 1024 ** 3)).toBe("3.3 GB");
    expect(formatBytes(2048 * 1024 ** 3)).toBe("2048 GB");
  });
});
