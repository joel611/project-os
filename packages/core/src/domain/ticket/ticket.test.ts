import { TICKET_STATUSES } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  assignTicket,
  canTransition,
  claimTicket,
  isTerminal,
  transitionTicket,
  type Ticket,
  type TicketStatus,
} from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const T1 = "2026-11-04T00:01:00.000Z";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "open",
  title: "x",
  intent: null,
  inputSummary: "x",
  priority: null,
  workerType: null,
  workerId: null,
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: null,
  startedAt: null,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
  ...over,
});

const legal: ReadonlyArray<readonly [TicketStatus, TicketStatus]> = [
  ["open", "assigned"],
  ["open", "failed"],
  ["open", "cancelled"],
  ["assigned", "in_progress"],
  ["assigned", "failed"],
  ["assigned", "cancelled"],
  ["in_progress", "blocked"],
  ["in_progress", "completed"],
  ["in_progress", "failed"],
  ["in_progress", "cancelled"],
  ["blocked", "in_progress"],
  ["blocked", "failed"],
  ["blocked", "cancelled"],
];

describe("ticket status machine", () => {
  it("allows exactly the legal transitions", () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it("terminal states have no exits", () => {
    for (const s of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminal(s)).toBe(true);
      for (const to of TICKET_STATUSES) expect(canTransition(s, to)).toBe(false);
    }
    expect(isTerminal("blocked")).toBe(false);
  });

  it("transition stamps timestamps and result", async () => {
    const t = await Effect.runPromise(
      transitionTicket(ticket({ status: "in_progress", startedAt: T0 }), "completed", T1, {
        result: { ok: true },
      }),
    );
    expect(t).toMatchObject({
      status: "completed",
      completedAt: T1,
      lastActivityAt: T1,
      result: { ok: true },
      startedAt: T0,
    });
  });

  it("rejects illegal transition with InvalidTransition", async () => {
    const err = await Effect.runPromise(Effect.flip(transitionTicket(ticket(), "completed", T1)));
    expect(err).toMatchObject({ _tag: "InvalidTransition", from: "open", to: "completed" });
  });

  it("assign moves open → assigned and sets the worker", async () => {
    const t = await Effect.runPromise(
      assignTicket(ticket(), { workerId: "w1", workerType: "local_claude" }, T1),
    );
    expect(t).toMatchObject({
      status: "assigned",
      workerId: "w1",
      workerType: "local_claude",
      assignedAt: T1,
    });
  });
});

describe("claim", () => {
  const assigned = ticket({ status: "assigned", workerId: "w1", assignedAt: T0 });

  it("moves assigned → in_progress for the assigned worker", async () => {
    const t = await Effect.runPromise(claimTicket(assigned, "w1", T1));
    expect(t).toMatchObject({ status: "in_progress", startedAt: T1 });
  });

  it("rejects a different worker", async () => {
    const err = await Effect.runPromise(Effect.flip(claimTicket(assigned, "w2", T1)));
    expect(err._tag).toBe("ClaimConflict");
  });

  it.each(["open", "in_progress", "blocked", "completed", "failed", "cancelled"] as const)(
    "rejects claim from %s",
    async (status) => {
      const err = await Effect.runPromise(
        Effect.flip(claimTicket({ ...assigned, status }, "w1", T1)),
      );
      expect(err).toMatchObject({ _tag: "ClaimConflict", status });
    },
  );
});
