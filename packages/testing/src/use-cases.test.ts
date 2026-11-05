import {
  appendEvent,
  claimTicketUseCase,
  getTicket,
  handleInbound,
  heartbeat,
  listAssigned,
  MemoryRepository,
  onTicketCompleted,
  ProjectRepository,
  ProjectSourceRepository,
  readMemory,
  TicketRepository,
  updateProject,
  updateStatus,
  writeMemory,
  type Project,
  type ProjectSource,
  type Ticket,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const ADMIN = "admin-chan";

const project: Project = {
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "",
  defaultResponseChannelId: null,
  status: "active",
  createdBy: null,
  createdAt: T0,
  updatedAt: T0,
};

const source = (over: Partial<ProjectSource> = {}): ProjectSource => ({
  id: "s1",
  projectId: "p1",
  type: "discord_channel",
  externalId: "chan-1",
  name: "#general",
  direction: "both",
  isDefaultResponse: true,
  config: {},
  status: "active",
  connectedBy: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "assigned",
  title: "Fix login",
  intent: null,
  inputSummary: "Fix login",
  priority: null,
  workerType: "local_claude",
  workerId: "w1",
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: null,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
  ...over,
});

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  sender: { id: "u1" },
  content: "please fix login",
  raw: {},
  receivedAt: T0,
  ...over,
});

const setup = Effect.gen(function* () {
  yield* (yield* ProjectRepository).insert(project);
  yield* (yield* ProjectSourceRepository).insert(source());
});

const run = <A, E>(
  eff: Effect.Effect<A, E, any>,
  options?: Parameters<typeof makeTestLayer>[0],
) => {
  const t = makeTestLayer(options);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* setup;
      return yield* eff;
    }).pipe(Effect.provide(t.layer)) as Effect.Effect<A, E>,
  ).then((value) => ({ value, sent: t.sent }));
};

const inbound = (intent: string, confidence = 1) => ({
  classifier: classifierReturning(intent, confidence, "local_pi"),
});
const config = { adminChannelId: ADMIN, workerId: "w1" };

describe("handleInbound", () => {
  it("new_request creates an assigned ticket with created + assigned events", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(msg(), config);
        if (out.kind !== "ticket_created") throw new Error(out.kind);
        return yield* getTicket({ ticketId: out.ticket.id });
      }),
      inbound("new_request"),
    );
    expect(value.ticket).toMatchObject({
      status: "assigned",
      workerId: "w1",
      workerType: "local_pi",
      projectId: "p1",
    });
    expect(value.events.map((e) => e.type)).toEqual(["created", "assigned"]);
  });

  it("dedupes by externalId", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const first = yield* handleInbound(msg(), config);
        const second = yield* handleInbound(msg(), config);
        return [first.kind, second.kind];
      }),
      inbound("new_request"),
    );
    expect(value).toEqual(["ticket_created", "duplicate"]);
  });

  it("ignores messages from unlinked channels", async () => {
    const { value, sent } = await run(
      handleInbound(msg({ channelId: "nope" }), config),
      inbound("new_request"),
    );
    expect(value.kind).toBe("unlinked");
    expect(sent).toHaveLength(0);
  });

  it("follow_up appends a follow_up event to the project's open ticket", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket());
        const out = yield* handleInbound(msg(), config);
        const { events } = yield* getTicket({ ticketId: "t1" });
        return { out, types: events.map((e) => e.type) };
      }),
      inbound("follow_up"),
    );
    expect(value.out).toEqual({ kind: "follow_up_added", ticketId: "t1" });
    expect(value.types).toEqual(["follow_up"]);
  });

  it("follow_up targets the most recently active ticket and ignores terminal ones", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ id: "old", lastActivityAt: T0 }));
        yield* repo.insert(ticket({ id: "new", lastActivityAt: "2026-11-04T00:05:00.000Z" }));
        yield* repo.insert(
          ticket({ id: "done", status: "completed", lastActivityAt: "2026-11-04T00:09:00.000Z" }),
        );
        return yield* handleInbound(msg(), config);
      }),
      inbound("follow_up"),
    );
    expect(value).toEqual({ kind: "follow_up_added", ticketId: "new" });
  });

  it("follow_up with no open ticket asks for clarification", async () => {
    const { value, sent } = await run(handleInbound(msg(), config), inbound("follow_up"));
    expect(value.kind).toBe("clarification_sent");
    expect(sent).toHaveLength(1);
  });

  it("status_question answers from ticket state via AgentRuntime", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket());
        return yield* handleInbound(msg({ threadId: "th1" }), config);
      }),
      inbound("status_question"),
    );
    expect(value.kind).toBe("status_answered");
    expect(sent[0]).toMatchObject({ channelId: "chan-1", threadId: "th1" });
    expect(sent[0]!.content).toContain("Fix login [assigned]");
  });

  it("admin_command in the admin channel goes to the admin dialogue", async () => {
    const { value, sent } = await run(
      handleInbound(msg({ channelId: ADMIN, content: "add project" }), config),
      inbound("admin_command"),
    );
    expect(value.kind).toBe("admin_handled");
    expect(sent[0]).toMatchObject({ channelId: ADMIN, content: "add project" });
  });

  it("admin_command outside the admin channel is not honoured", async () => {
    const { value } = await run(handleInbound(msg(), config), inbound("admin_command"));
    expect(value.kind).toBe("clarification_sent");
  });

  it("admin channel with a non-admin intent or low confidence asks for clarification", async () => {
    const adminMsg = msg({ channelId: ADMIN });
    const low = await run(handleInbound(adminMsg, config), inbound("admin_command", 0.1));
    expect(low.value.kind).toBe("clarification_sent");
    const other = await run(handleInbound(adminMsg, config), inbound("new_request"));
    expect(other.value.kind).toBe("clarification_sent");
  });

  it("messages from a channel type with no source mapping are unlinked", async () => {
    const { value } = await run(
      handleInbound(msg({ channelType: "chat" }), config),
      inbound("new_request"),
    );
    expect(value.kind).toBe("unlinked");
  });

  it("status_question with no active tickets says so", async () => {
    const { value, sent } = await run(handleInbound(msg(), config), inbound("status_question"));
    expect(value.kind).toBe("status_answered");
    expect(sent).toHaveLength(1);
  });

  it("low confidence asks a clarifying question and creates nothing", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(msg(), config);
        const open = yield* (yield* TicketRepository).listByStatus(["open", "assigned"]);
        return { out, open };
      }),
      inbound("new_request", 0.2),
    );
    expect(value.out.kind).toBe("clarification_sent");
    expect(value.open).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("intent none asks a clarifying question", async () => {
    const { value } = await run(handleInbound(msg(), config), inbound("none"));
    expect(value.kind).toBe("clarification_sent");
  });
});

describe("ticket use cases", () => {
  it("listAssigned, claimTicket, appendEvent, updateStatus, getTicket", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket());
        const assigned = yield* listAssigned({ workerId: "w1" });
        const claimed = yield* claimTicketUseCase({ ticketId: "t1", workerId: "w1" });
        yield* appendEvent({ ticketId: "t1", type: "comment", actor: "worker", body: "hi" });
        yield* updateStatus({ ticketId: "t1", status: "completed" });
        const got = yield* getTicket({ ticketId: "t1" });
        return { assigned, claimed, got };
      }),
    );
    expect(value.assigned.map((t) => t.id)).toEqual(["t1"]);
    expect(value.claimed.status).toBe("in_progress");
    expect(value.got.ticket.status).toBe("completed");
    expect(value.got.events.map((e) => e.body)).toEqual(["hi"]);
  });

  it("claim by a different worker conflicts", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket());
        return yield* Effect.flip(claimTicketUseCase({ ticketId: "t1", workerId: "other" }));
      }),
    );
    expect(value._tag).toBe("ClaimConflict");
  });

  it("updateStatus rejects invalid transitions", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket());
        return yield* Effect.flip(updateStatus({ ticketId: "t1", status: "completed" }));
      }),
    );
    expect(value._tag).toBe("InvalidTransition");
  });
});

describe("updateProject", () => {
  it("patches given fields only, can clear the slug, and 404s unknown projects", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const named = yield* updateProject({ projectId: "p1", name: "New", slug: "new" });
        const cleared = yield* updateProject({ projectId: "p1", slug: null });
        const miss = yield* Effect.flip(updateProject({ projectId: "nope" }));
        return { named, cleared, miss };
      }),
    );
    expect(value.named).toMatchObject({ name: "New", slug: "new" });
    expect(value.cleared).toMatchObject({ name: "New", slug: null });
    expect(value.miss._tag).toBe("ProjectNotFound");
  });
});

describe("memory use cases", () => {
  it("writeMemory links an explicit ticket and reads it back", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* writeMemory({
          projectId: "p1",
          ticketId: "t1",
          type: "note",
          title: "n",
          content: "c",
        });
        return yield* readMemory({ projectId: "p1", type: "note" });
      }),
    );
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ ticketId: "t1", content: "c" });
  });

  it("writeMemory auto-links the worker's current ticket", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* heartbeat({ workerId: "w1", workerType: "local_claude", ticketId: "t9" });
        yield* writeMemory({
          projectId: "p1",
          workerId: "w1",
          type: "worker_note",
          title: "n",
          content: "c",
        });
        return yield* (yield* MemoryRepository).list("p1");
      }),
    );
    expect(value[0]).toMatchObject({ ticketId: "t9", createdBy: "w1" });
  });

  it("writeMemory without ticket or known worker leaves ticketId null", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const entry = yield* writeMemory({
          projectId: "p1",
          workerId: "ghost",
          type: "note",
          title: "n",
          content: "c",
        });
        return entry.ticketId;
      }),
    );
    expect(value).toBeNull();
  });
});

describe("heartbeat", () => {
  it("upserts the worker and bumps lastSeenAt", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const a = yield* heartbeat({ workerId: "w1", workerType: "local_claude" });
        const b = yield* heartbeat({ workerId: "w1", workerType: "local_claude", ticketId: "t1" });
        return { a, b };
      }),
    );
    expect(value.a.currentTicketId).toBeNull();
    expect(value.b).toMatchObject({ currentTicketId: "t1", lastSeenAt: T0 });
  });
});

describe("onTicketCompleted", () => {
  it("sends the composed reply to the default response source", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(ticket({ status: "completed", result: "done" }));
        return yield* onTicketCompleted({ ticketId: "t1" });
      }),
    );
    expect(value).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelType: "discord", channelId: "chan-1" });
    expect(sent[0]!.content).toContain("done");
  });

  it("sends nothing when no default response source exists", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        yield* (yield* ProjectSourceRepository).setDefaultResponse("p1", "s1");
        yield* (yield* ProjectSourceRepository).insert(
          source({ id: "s2", type: "github_repo", externalId: "r", isDefaultResponse: false }),
        );
        yield* (yield* ProjectSourceRepository).setDefaultResponse("p1", "s2");
        yield* (yield* TicketRepository).insert(ticket({ status: "completed" }));
        return yield* onTicketCompleted({ ticketId: "t1" });
      }),
    );
    expect(value).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
