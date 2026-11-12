import type { ActivityFeed, ActivityTicket, TicketEvent } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyFeed,
  channelsOf,
  emptyModel,
  identityOf,
  ticketLabel,
  workerSlots,
  type Step,
} from "./feed.ts";

const T = (s: number) => `2026-11-06T00:00:${String(s).padStart(2, "0")}.000Z`;

const ticket = (over: Partial<ActivityTicket> = {}): ActivityTicket => ({
  id: "t1",
  projectId: "p1",
  status: "assigned",
  title: "Checkout returns 500",
  intent: "new_request",
  inputSummary: "",
  priority: null,
  workerType: "local",
  workerId: "w1",
  requester: null,
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

const event = (
  id: string,
  type: TicketEvent["type"],
  at: number,
  over: Partial<TicketEvent> = {},
): TicketEvent => ({
  id,
  ticketId: "t1",
  type,
  actor: "coordinator",
  actorId: null,
  body: "",
  payload: null,
  createdAt: T(at),
  ...over,
});

const feed = (
  now: number,
  tickets: ActivityTicket[],
  events: TicketEvent[] = [],
): ActivityFeed => ({
  now: T(now),
  tickets,
  events,
  workers: [
    {
      id: "w1",
      workerType: "local",
      ownerChannelType: null,
      ownerId: null,
      registered: false,
      name: null,
      currentTicketId: null,
      lastSeenAt: T(0),
      createdAt: T(0),
      status: "online",
    },
  ],
});

const travels = (steps: ReadonlyArray<Step>) =>
  steps.flatMap((s) =>
    s.type === "travel"
      ? [`${s.from} -> ${s.to} ${s.packet.kind === "call" ? s.packet.label : s.packet.kind}`]
      : [],
  );

describe("applyFeed", () => {
  it("treats the first read as a baseline without stories", () => {
    const { model, stories } = applyFeed(
      emptyModel,
      feed(5, [ticket()], [event("e1", "created", 1)]),
    );
    expect(stories).toEqual([]);
    expect(model.since).toBe(T(5));
    expect(model.tickets.get("t1")?.status).toBe("assigned");
    expect(model.log.map((l) => l.id)).toEqual(["e1:ticket", "e1:intent", "e1:message"]);
  });

  it("tells a new ticket's story from the channel to the Coordinator's queue", () => {
    const base = applyFeed(emptyModel, feed(0, [])).model;
    const { stories } = applyFeed(
      base,
      feed(2, [ticket()], [event("e1", "created", 1), event("e2", "assigned", 1)]),
    );
    expect(stories).toHaveLength(1);
    expect(travels(stories[0]!.steps)).toEqual([
      "channel:discord -> adapter:discord message",
      "adapter:discord -> coordinator message",
    ]);
    expect(
      stories[0]!.steps
        .filter((s) => s.type === "status")
        .map((s) => s.type === "status" && s.status),
    ).toEqual(["open", "assigned"]);
  });

  it("claims, works and completes a ticket, then replies on the project's channel", () => {
    const base = applyFeed(emptyModel, feed(2, [ticket()])).model;
    const done = ticket({
      status: "completed",
      startedAt: T(3),
      completedAt: T(6),
      updatedAt: T(6),
    });
    const { stories } = applyFeed(
      base,
      feed(
        7,
        [done],
        [
          event("e3", "status_update", 4, { actor: "worker" }),
          event("e4", "result", 5, { actor: "worker" }),
        ],
      ),
    );
    expect(travels(stories[0]!.steps)).toEqual([
      "worker:w1 -> coordinator ticket_claim",
      "coordinator -> worker:w1 ticket",
      "worker:w1 -> coordinator status_update",
      "worker:w1 -> coordinator result",
      "worker:w1 -> coordinator ticket",
      "coordinator -> adapter:discord reply",
      "adapter:discord -> channel:discord reply",
    ]);
  });

  it("skips events it has already seen and tickets that did not change", () => {
    const first = applyFeed(emptyModel, feed(2, [ticket()], [event("e1", "created", 1)])).model;
    const { stories, model } = applyFeed(first, feed(3, [ticket()], [event("e1", "created", 1)]));
    expect(stories).toEqual([]);
    expect(model.log).toHaveLength(3);
  });

  it("routes a follow-up from its sender to the working worker", () => {
    const base = applyFeed(
      emptyModel,
      feed(2, [ticket({ status: "in_progress", startedAt: T(1) })]),
    ).model;
    const followUp = event("e5", "follow_up", 3, {
      payload: { sender: { id: "u2", name: "devon" } },
    });
    const { stories } = applyFeed(
      base,
      feed(4, [ticket({ status: "in_progress", startedAt: T(1), updatedAt: T(3) })], [followUp]),
    );
    const first = stories[0]!.steps[0]!;
    expect(
      first.type === "travel" && first.packet.kind === "message" && first.packet.who.name,
    ).toBe("devon");
    expect(travels(stories[0]!.steps).at(-1)).toBe("coordinator -> worker:w1 follow_up");
  });
});

describe("map contents", () => {
  it("draws Discord and email always, and chat once a ticket uses it", () => {
    expect(channelsOf([ticket()])).toEqual(["discord", "email"]);
    expect(channelsOf([ticket({ origin: { channelType: "chat", sender: { id: "x" } } })])).toEqual([
      "discord",
      "email",
      "chat",
    ]);
  });

  it("adds a block for a worker a live ticket waits on before it checks in", () => {
    expect(workerSlots([], [ticket({ workerId: null, workerType: "daytona_pi" })])).toEqual([
      { id: "any daytona_pi", workerType: "daytona_pi" },
    ]);
    expect(workerSlots([], [ticket({ status: "completed" })])).toEqual([]);
  });

  it("gives a sender stable initials and colour", () => {
    const a = identityOf({
      channelType: "email",
      sender: { id: "p@acme.co", email: "priya@acme.co" },
    });
    expect(a).toMatchObject({ initials: "PA", channel: "email", name: "priya@acme.co" });
    expect(identityOf({ channelType: "email", sender: { id: "p@acme.co" } }).color).toBe(a.color);
  });
});

describe("applyFeed, other endings", () => {
  const working = ticket({ status: "in_progress", startedAt: T(1) });
  const after = (t: ActivityTicket, events: TicketEvent[] = []) =>
    applyFeed(applyFeed(emptyModel, feed(2, [working])).model, feed(9, [t], events)).stories;

  it("sends a failed ticket back as a red chip, and a blocked one as a call", () => {
    const failed = after(ticket({ status: "failed", startedAt: T(1), updatedAt: T(8) }));
    const step = failed[0]!.steps[0]!;
    expect(step.type === "travel" && step.packet).toEqual({
      kind: "ticket",
      ticketId: "t1",
      tone: "failed",
    });
    expect(
      travels(after(ticket({ status: "blocked", startedAt: T(1), updatedAt: T(8) }))[0]!.steps),
    ).toEqual(["worker:w1 -> coordinator blocked"]);
  });

  it("only updates the status of a ticket cancelled before it started", () => {
    const base = applyFeed(emptyModel, feed(2, [ticket()])).model;
    const { stories } = applyFeed(
      base,
      feed(9, [ticket({ status: "cancelled", updatedAt: T(8) })]),
    );
    expect(stories[0]!.steps).toEqual([{ type: "status", ticketId: "t1", status: "cancelled" }]);
  });

  it("completes without a reply when the project has no reply channel or sender", () => {
    const steps = after(
      ticket({ status: "completed", startedAt: T(1), updatedAt: T(8), replyChannel: null }),
    )[0]!.steps;
    expect(travels(steps)).toEqual(["worker:w1 -> coordinator ticket"]);
    const anonymous = after(
      ticket({ status: "completed", startedAt: T(1), updatedAt: T(8), origin: null }),
    )[0]!.steps;
    const reply = anonymous.find((s) => s.type === "travel" && s.packet.kind === "reply");
    expect(reply?.type === "travel" && reply.packet).toEqual({ kind: "reply", who: null });
  });

  it("tells nothing for a ticket whose only change is its timestamp", () => {
    expect(after(ticket({ status: "in_progress", startedAt: T(1), updatedAt: T(8) }))).toEqual([]);
  });

  it("orders several tickets by when they changed", () => {
    const base = applyFeed(emptyModel, feed(0, [])).model;
    const late = ticket({ id: "t2", updatedAt: T(5) });
    const early = ticket({ id: "t3", updatedAt: T(3) });
    const { stories } = applyFeed(base, feed(6, [late, early]));
    expect(stories.map((s) => s.ticketId)).toEqual(["t3", "t2"]);
  });

  it("leaves out the worker steps for a ticket with no worker", () => {
    const base = applyFeed(emptyModel, feed(0, [])).model;
    const loose = ticket({ workerId: null, workerType: null, status: "open", origin: null });
    const { stories } = applyFeed(
      base,
      feed(3, [loose], [event("e1", "created", 1), event("e2", "comment", 2, { actor: "worker" })]),
    );
    expect(travels(stories[0]!.steps)).toEqual([]);
  });

  it("does not ping the worker about a follow-up before it starts, and copes without a sender", () => {
    const base = applyFeed(emptyModel, feed(2, [ticket()])).model;
    const { stories } = applyFeed(
      base,
      feed(4, [ticket({ updatedAt: T(3) })], [event("e5", "follow_up", 3)]),
    );
    expect(travels(stories[0]!.steps)).toEqual([
      "channel:discord -> adapter:discord message",
      "adapter:discord -> coordinator message",
    ]);
    const nobody = applyFeed(
      applyFeed(emptyModel, feed(2, [ticket({ origin: null })])).model,
      feed(
        4,
        [ticket({ origin: null, updatedAt: T(3) })],
        [event("e6", "follow_up", 3, { payload: { sender: { id: "u9" } } })],
      ),
    );
    expect(travels(nobody.stories[0]!.steps)).toEqual([]);
  });
});

describe("labels and identity", () => {
  it("shortens ticket ids to their last four letters or digits", () => {
    expect(ticketLabel("22bcc1e3-cf18-454e-8b50-6265d257df0f")).toBe("#df0f");
  });

  it("falls back to the sender id, and to a question mark when nothing is readable", () => {
    expect(identityOf({ channelType: "discord", sender: { id: "ada" } }).initials).toBe("A");
    expect(identityOf({ channelType: "discord", sender: { id: "..." } }).initials).toBe("?");
    expect(
      identityOf({ channelType: "discord", sender: { id: "u1", name: "Ada Lovelace" } }).initials,
    ).toBe("AL");
  });

  it("sorts worker blocks and ignores live tickets with no worker", () => {
    const w = (id: string) => ({
      id,
      workerType: "daytona_pi" as const,
      ownerChannelType: null,
      ownerId: null,
      registered: false,
      name: null,
      currentTicketId: null,
      lastSeenAt: T(0),
      createdAt: T(0),
      status: "online" as const,
    });
    expect(
      workerSlots(
        [w("b"), w("a")],
        [ticket({ workerId: "a" }), ticket({ workerId: null, workerType: null })],
      ).map((s) => s.id),
    ).toEqual(["a", "b"]);
  });

  it("keeps the default channels when tickets carry no channel", () => {
    expect(channelsOf([ticket({ origin: null, replyChannel: null })])).toEqual([
      "discord",
      "email",
    ]);
  });
});
