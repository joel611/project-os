import type { ActivityTicket, TicketEvent } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { eventLines, newestFirst, transitionLines, workerName, type LogLine } from "./log.ts";

const T = (s: number) => `2026-11-06T00:00:${String(s).padStart(2, "0")}.000Z`;

const ticket = (over: Partial<ActivityTicket> = {}): ActivityTicket => ({
  id: "t-0142",
  projectId: "p1",
  status: "assigned",
  title: "Checkout returns 500",
  intent: "new_request",
  inputSummary: "",
  priority: null,
  workerType: "local",
  workerId: "w1",
  result: null,
  error: null,
  createdAt: T(1),
  assignedAt: T(1),
  startedAt: null,
  lastActivityAt: T(1),
  completedAt: null,
  updatedAt: T(1),
  origin: { channelType: "discord", sender: { id: "u1", name: "mira.k" } },
  replyChannel: "discord",
  ...over,
});

const event = (type: TicketEvent["type"], over: Partial<TicketEvent> = {}): TicketEvent => ({
  id: "e1",
  ticketId: "t-0142",
  type,
  actor: "coordinator",
  actorId: null,
  body: "",
  payload: null,
  createdAt: T(2),
  ...over,
});

/** A line as text, people as @name, code as `code`. */
const text = (l: LogLine) =>
  l.parts
    .map((p) => (typeof p === "string" ? p : "code" in p ? `\`${p.code}\`` : `@${p.who.name}`))
    .join("");

const mira = { sender: { id: "u1", name: "mira.k" }, channelType: "discord" };

describe("workerName", () => {
  it("names a worker by its type and id", () => {
    expect(workerName("w1", "daytona_pi")).toBe("Pi (Daytona) (w1)");
    expect(workerName("w1", null)).toBe("w1");
    expect(workerName(null, "local")).toBe("Local computer");
    expect(workerName(undefined, undefined)).toBe("a worker");
  });
});

describe("eventLines", () => {
  it("turns a created event into the message, the classification and the ticket", () => {
    const lines = eventLines(event("created", { body: "checkout 500s", payload: mira }), ticket());
    expect(lines.map(text)).toEqual([
      "@mira.k on Discord: “checkout 500s”",
      "Jev classified it as `new_request`",
      "Created ticket `#0142` (open)",
    ]);
    expect(lines.map((l) => l.tone)).toEqual(["discord", "coordinator", "coordinator"]);
  });

  it("falls back when the sender, channel or intent is unknown", () => {
    const lines = eventLines(
      event("created", { payload: { sender: { id: "u2" } } }),
      ticket({ intent: null, origin: null }),
    );
    expect(lines.map(text)).toEqual(["A message", "Created ticket `#0142` (open)"]);
    expect(lines[0]!.tone).toBe("coordinator");
    expect(eventLines(event("created", { payload: mira }), undefined).map(text)).toEqual([
      "@mira.k on Discord",
      "Created ticket `#0142` (open)",
    ]);
  });

  it("takes the channel from the ticket when the event has none", () => {
    const [line] = eventLines(
      event("created", { payload: { sender: { id: "u1", email: "a@b.co" } } }),
      ticket({ origin: { channelType: "email", sender: { id: "u1" } } }),
    );
    expect(text(line!)).toBe("@a@b.co by email");
    expect(line!.tone).toBe("email");
  });

  it("says who a ticket was assigned to", () => {
    const by = (payload: unknown) => text(eventLines(event("assigned", { payload }), ticket())[0]!);
    expect(by({ workerType: "local", workerId: "w1" })).toBe(
      "Marked `#0142` assigned to Local computer (w1). Waiting for it to pull.",
    );
    expect(by({ workerType: "local", workerId: null })).toBe(
      "Marked `#0142` assigned to Local computer. Waiting for it to pull.",
    );
    expect(by(null)).toBe("Marked `#0142` assigned to a worker. Waiting for it to pull.");
  });

  it("logs a follow-up and where it was appended", () => {
    const lines = eventLines(
      event("follow_up", { body: "also on mobile", payload: mira }),
      ticket(),
    );
    expect(lines.map(text)).toEqual([
      "@mira.k followed up on `#0142`: “also on mobile”",
      "Appended a `follow_up` event to `#0142`. The worker sees it on its next `ticket_get`.",
    ]);
    expect(text(eventLines(event("follow_up"), undefined)[0]!)).toBe("Follow-up on `#0142`");
  });

  it("logs what a worker posted", () => {
    const worker = (type: TicketEvent["type"], over: Partial<TicketEvent> = {}) =>
      eventLines(event(type, { actor: "worker", ...over }), ticket())[0]!;
    expect(text(worker("status_update", { actorId: "w9", body: "on it" }))).toBe(
      "w9 posted a status update on `#0142`: on it",
    );
    expect(text(worker("comment", { actorId: "w1" }))).toBe(
      "Local computer (w1) commented on `#0142`",
    );
    expect(text(worker("comment"))).toBe("Local computer (w1) commented on `#0142`");
    expect(text(worker("result"))).toBe("Local computer (w1) posted the result for `#0142`");
    const error = worker("error");
    expect(text(error)).toBe("Local computer (w1) reported an error on `#0142`");
    expect(error.tone).toBe("failed");
    expect(text(eventLines(event("comment", { actor: "worker" }), undefined)[0]!)).toBe(
      "a worker commented on `#0142`",
    );
  });

  it("logs anything else as the Coordinator's", () => {
    expect(text(eventLines(event("system", { body: "Ticket timed out" }), ticket())[0]!)).toBe(
      "`#0142` Ticket timed out",
    );
    expect(text(eventLines(event("comment"), ticket())[0]!)).toBe("`#0142` comment");
  });
});

describe("transitionLines", () => {
  it("logs a claim, a completion and the reply", () => {
    const done = ticket({ status: "completed", startedAt: T(3), completedAt: T(6) });
    const lines = transitionLines(done, "assigned");
    expect(lines.map(text)).toEqual([
      "Local computer (w1) claimed `#0142`, now in progress",
      "`#0142` completed by Local computer (w1)",
      "Coordinator replied to @mira.k on Discord",
    ]);
    expect(lines.map((l) => l.at)).toEqual([T(3), T(6), T(6)]);
  });

  it("logs a claim on a ticket it has not seen before", () => {
    const working = ticket({ status: "in_progress", startedAt: T(3) });
    expect(transitionLines(working, undefined).map(text)).toEqual([
      "Local computer (w1) claimed `#0142`, now in progress",
    ]);
    expect(transitionLines(working, "in_progress")).toEqual([]);
    expect(transitionLines(working, "open")).toHaveLength(1);
  });

  it("replies without a name when the ticket has no sender", () => {
    const done = ticket({ status: "completed", origin: null, replyChannel: "email" });
    expect(transitionLines(done, "in_progress").map(text)).toEqual([
      "`#0142` completed by Local computer (w1)",
      "Coordinator replied by email",
    ]);
    const silent = ticket({ status: "completed", replyChannel: null, workerId: null });
    expect(transitionLines(silent, "in_progress").map(text)).toEqual([
      "`#0142` completed by Local computer",
    ]);
  });

  it("logs failures, blocks and cancellations", () => {
    const end = (over: Partial<ActivityTicket>) => transitionLines(ticket(over), "in_progress");
    expect(end({ status: "failed", error: "OOM" }).map(text)).toEqual(["`#0142` failed: OOM"]);
    expect(end({ status: "failed" }).map(text)).toEqual(["`#0142` failed"]);
    expect(end({ status: "blocked" }).map(text)).toEqual(["`#0142` is blocked"]);
    expect(end({ status: "cancelled" }).map(text)).toEqual(["`#0142` was cancelled"]);
    expect(end({ status: "open" })).toEqual([]);
  });
});

describe("newestFirst", () => {
  it("sorts by time, later lines first when times match", () => {
    const line = (id: string, at: number): LogLine => ({ id, at: T(at), tone: "ok", parts: [] });
    expect(newestFirst([line("a", 1), line("b", 2), line("c", 2)]).map((l) => l.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});
