import {
  addSource,
  appendEvent,
  claimTicketUseCase,
  getMyTicket,
  getTicket,
  handleInbound,
  listMyTickets,
  heartbeat,
  listAssigned,
  listProjectSources,
  MEMORY_SAVED_MESSAGE,
  MemoryRepository,
  onTicketCompleted,
  ProjectRepository,
  ProjectSourceRepository,
  readMemory,
  removeSource,
  TicketRepository,
  updateProject,
  updateSource,
  QUEUED_MESSAGE,
  updateStatus,
  WorkerRepository,
  writeMemory,
  type Project,
  type ProjectSource,
  sidekickFailedMessage,
  THREAD_OPENED_MESSAGE,
  TICKET_CLOSED_MESSAGE,
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
  channelDigest: true,
  channelDigestNotify: false,
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
  alias: `src-${over.id ?? "s1"}`,
  description: null,
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
  workerType: "local",
  workerId: "w1",
  requester: null,
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

/** A shared device an admin registered, online: "w1" takes tickets nobody else does. */
const sharedDevice = (id = "w1") =>
  Effect.gen(function* () {
    yield* (yield* WorkerRepository).register({
      id,
      workerType: "local",
      owner: null,
      name: id,
      secretHash: `hash-${id}`,
      at: T0,
    });
    yield* heartbeat({ workerId: id, workerType: "local" });
  });

type RunOptions = Parameters<typeof makeTestLayer>[0] & {
  /** Register the shared device "w1" first. Default true. */
  readonly shared?: boolean;
};

const run = <A, E>(
  eff: Effect.Effect<A, E, any>,
  { shared = true, ...options }: RunOptions = {},
  before?: (t: ReturnType<typeof makeTestLayer>) => void,
) => {
  const t = makeTestLayer(options);
  before?.(t);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* setup;
      if (shared) yield* sharedDevice();
      return yield* eff;
    }).pipe(Effect.provide(t.layer)) as Effect.Effect<A, E>,
  ).then((value) => ({
    value,
    sent: t.sent,
    threads: t.createdThreads,
    reactions: t.reactions,
    launched: t.launched,
    sidekick: t.sidekickCalls,
  }));
};

const inbound = (intent: string, confidence = 1) => ({
  classifier: classifierReturning(intent, confidence),
});
const config = { adminChannelId: ADMIN, sharedWorkerMaxTickets: 100 };

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
      workerType: "local",
      projectId: "p1",
    });
    expect(value.events.map((e) => e.type)).toEqual(["created", "assigned"]);
  });

  describe("when no worker has room", () => {
    const newTicket = (cfg: Parameters<typeof handleInbound>[1] = config, externalId = "m1") =>
      Effect.gen(function* () {
        const out = yield* handleInbound(msg({ externalId }), cfg);
        if (out.kind !== "ticket_created") throw new Error(out.kind);
        return out.ticket;
      });
    const asNew = classifierReturning("new_request");

    it("queues the ticket, and says so in its thread, when no worker has room", async () => {
      const { value, sent, launched } = await run(
        Effect.gen(function* () {
          const ticket = yield* newTicket();
          return { ticket, events: (yield* getTicket({ ticketId: ticket.id })).events };
        }),
        { classifier: asNew, shared: false },
      );
      expect(value.ticket).toMatchObject({ status: "open", workerType: null, workerId: null });
      expect(value.events.map((e) => [e.type, e.payload])).toEqual([
        ["created", expect.anything()],
        ["system", { kind: "queued" }],
      ]);
      expect(sent.map((r) => [r.threadId, r.content])).toEqual([
        ["thread-1", THREAD_OPENED_MESSAGE],
        ["thread-1", QUEUED_MESSAGE],
      ]);
      expect(launched).toEqual([]);
    });
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

  it("reacts 👀 to a message it takes in, and not again to a redelivery", async () => {
    const { value, reactions } = await run(
      Effect.gen(function* () {
        yield* handleInbound(msg({ threadId: "th1" }), config);
        return (yield* handleInbound(msg({ threadId: "th1" }), config)).kind;
      }),
      inbound("new_request"),
    );
    expect(value).toBe("duplicate");
    expect(reactions).toEqual([
      {
        channelType: "discord",
        channelId: "chan-1",
        threadId: "th1",
        messageId: "m1",
        emoji: "👀",
      },
    ]);
  });

  it("carries on when the reaction fails", async () => {
    const { value, reactions } = await run(handleInbound(msg(), config), {
      ...inbound("new_request"),
      failReact: "Missing Permissions",
    });
    expect(value.kind).toBe("ticket_created");
    expect(reactions).toEqual([]);
  });

  it("reacts to admin channel messages from an admin, not from anyone else", async () => {
    const admins = { ...config, adminUserIds: ["u1"] };
    const ok = await run(
      handleInbound(msg({ channelId: ADMIN }), admins),
      inbound("admin_command"),
    );
    expect(ok.reactions).toHaveLength(1);
    const no = await run(
      handleInbound(msg({ channelId: ADMIN, sender: { id: "u2" } }), admins),
      inbound("admin_command"),
    );
    expect(no.value.kind).toBe("admin_forbidden");
    expect(no.reactions).toEqual([]);
  });

  it("ignores messages from unlinked channels", async () => {
    const { value, sent, reactions } = await run(
      handleInbound(msg({ channelId: "nope" }), config),
      inbound("new_request"),
    );
    expect(value.kind).toBe("unlinked");
    expect(sent).toHaveLength(0);
    expect(reactions).toEqual([]);
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

  it("remember writes the message to project memory and confirms", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(
          msg({ content: "remember this project is in POC" }),
          config,
        );
        return { out, entries: yield* readMemory({ projectId: "p1" }) };
      }),
      inbound("remember"),
    );
    expect(value.out.kind).toBe("memory_saved");
    expect(value.entries).toHaveLength(1);
    expect(value.entries[0]).toMatchObject({
      type: "manual",
      content: "remember this project is in POC",
    });
    expect(sent[0]!.content).toBe(MEMORY_SAVED_MESSAGE);
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

  describe("with requireMention", () => {
    const strict = { ...config, requireMention: true };

    it("ignores a top-level project channel message that doesn't mention the bot", async () => {
      for (const over of [{}, { mentionsBot: false }]) {
        const { value, sent, reactions } = await run(
          handleInbound(msg(over), strict),
          inbound("new_request"),
        );
        expect(value.kind).toBe("not_mentioned");
        expect(sent).toEqual([]);
        expect(reactions).toEqual([]);
      }
    });

    it("handles a message that mentions the bot", async () => {
      const { value } = await run(
        handleInbound(msg({ mentionsBot: true }), strict),
        inbound("new_request"),
      );
      expect(value.kind).toBe("ticket_created");
    });

    it("handles a thread message without a mention", async () => {
      const { value } = await run(
        handleInbound(msg({ threadId: "th1" }), strict),
        inbound("new_request"),
      );
      expect(value.kind).toBe("ticket_created");
    });

    it("still handles the admin channel without a mention", async () => {
      const { value } = await run(
        handleInbound(msg({ channelId: ADMIN }), strict),
        inbound("admin_command"),
      );
      expect(value.kind).toBe("admin_handled");
    });
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

describe("handleInbound ticket threads", () => {
  const linkT1 = Effect.gen(function* () {
    const repo = yield* TicketRepository;
    yield* repo.insert(ticket());
    yield* repo.linkThread({
      ticketId: "t1",
      channelType: "discord",
      channelId: "chan-1",
      threadId: "th1",
      createdAt: T0,
    });
  });

  it("new_request opens a thread on the message, links it, and says so there", async () => {
    const { value, sent, threads } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(msg(), config);
        if (out.kind !== "ticket_created") throw new Error(out.kind);
        return yield* (yield* TicketRepository).findThread(out.ticket.id);
      }),
      inbound("new_request"),
    );
    expect(threads).toEqual([
      { channelType: "discord", channelId: "chan-1", messageId: "m1", name: "please fix login" },
    ]);
    expect(value).toMatchObject({ channelId: "chan-1", threadId: "thread-1" });
    expect(sent).toEqual([
      {
        channelType: "discord",
        channelId: "chan-1",
        threadId: "thread-1",
        content: THREAD_OPENED_MESSAGE,
      },
    ]);
  });

  it("new_request still creates the ticket when the thread can't be opened", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(msg(), config);
        if (out.kind !== "ticket_created") throw new Error(out.kind);
        return yield* (yield* TicketRepository).findThread(out.ticket.id);
      }),
      { ...inbound("new_request"), failThreadCreate: "Missing Permissions" },
    );
    expect(value).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("new_request from a channel without threads (email) opens none", async () => {
    const { value, threads } = await run(
      Effect.gen(function* () {
        yield* (yield* ProjectSourceRepository).insert(
          source({
            id: "s2",
            type: "email_address",
            externalId: "a@b.c",
            isDefaultResponse: false,
          }),
        );
        return yield* handleInbound(msg({ channelType: "email", channelId: "a@b.c" }), config);
      }),
      inbound("new_request"),
    );
    expect(value.kind).toBe("ticket_created");
    expect(threads).toEqual([]);
  });

  it("a message in a ticket's thread is a follow-up on that ticket, whatever its intent", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        yield* linkT1;
        return yield* handleInbound(msg({ threadId: "th1" }), config);
      }),
      inbound("new_request", 0.1),
    );
    expect(value).toEqual({ kind: "follow_up_added", ticketId: "t1" });
    expect(sent).toEqual([]);
  });

  it("a status question in a ticket's thread is answered about that ticket", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        yield* linkT1;
        yield* (yield* TicketRepository).insert(ticket({ id: "t2", title: "Other work" }));
        return yield* handleInbound(msg({ threadId: "th1" }), config);
      }),
      inbound("status_question"),
    );
    expect(value.kind).toBe("status_answered");
    expect(sent[0]).toMatchObject({ threadId: "th1" });
    expect(sent[0]!.content).toContain("Fix login [assigned]");
    expect(sent[0]!.content).not.toContain("Other work");
  });

  it("a message in a finished ticket's thread says so and adds nothing", async () => {
    const { value, sent } = await run(
      Effect.gen(function* () {
        yield* linkT1;
        yield* (yield* TicketRepository).updateStatus("t1", "cancelled", T0);
        const out = yield* handleInbound(msg({ threadId: "th1" }), config);
        const { events } = yield* getTicket({ ticketId: "t1" });
        return { out, types: events.map((e) => e.type) };
      }),
      inbound("follow_up"),
    );
    expect(value.out).toEqual({ kind: "ticket_closed", ticketId: "t1" });
    expect(value.types).toEqual([]);
    expect(sent.map((s) => s.content)).toEqual([TICKET_CLOSED_MESSAGE]);
  });

  it("a thread linked to another project's ticket is treated as an ordinary thread", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert({ ...project, id: "p2" });
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ id: "x1", projectId: "p2" }));
        yield* repo.linkThread({
          ticketId: "x1",
          channelType: "discord",
          channelId: "elsewhere",
          threadId: "th1",
          createdAt: T0,
        });
        return yield* handleInbound(msg({ threadId: "th1" }), config);
      }),
      inbound("follow_up"),
    );
    expect(value.kind).toBe("clarification_sent");
  });
});

describe("handleInbound Sidekick", () => {
  const toSidekick = (intent = "new_request") => ({
    classifier: classifierReturning(intent, 1, "sidekick"),
  });
  const create = Effect.gen(function* () {
    const out = yield* handleInbound(msg({ content: "list my drive" }), config);
    if (out.kind !== "ticket_created") throw new Error(out.kind);
    const got = yield* getTicket({ ticketId: out.ticket.id });
    return { ...got, assignedToWorker: yield* listAssigned({ workerId: "w1" }) };
  });

  it("answers a tool-only request in the ticket thread and completes the ticket", async () => {
    const { value, sent, sidekick } = await run(create, toSidekick());

    expect(value.ticket).toMatchObject({
      status: "completed",
      workerType: "sidekick",
      workerId: "sidekick",
    });
    expect(value.events.map((e) => e.type)).toEqual(["created", "assigned", "result"]);
    expect(value.events.at(-1)?.body).toBe("sidekick: list my drive");
    expect(sent.map((r) => [r.threadId, r.content])).toEqual([
      ["thread-1", THREAD_OPENED_MESSAGE],
      ["thread-1", "sidekick: list my drive"],
    ]);
    expect(sidekick).toMatchObject([{ ticketId: value.ticket.id, requestId: "m1" }]);
  });

  it("leaves nothing for a Worker to pull", async () => {
    const { value } = await run(create, toSidekick());
    expect(value.assignedToWorker).toEqual([]);
  });

  it("sends a request without an executor, or for a Worker, to the Worker", async () => {
    for (const classifier of [
      classifierReturning("new_request"),
      classifierReturning("new_request", 1, "worker"),
    ]) {
      const { value, sidekick } = await run(create, { classifier });
      expect(value.ticket).toMatchObject({ status: "assigned", workerId: "w1" });
      expect(value.assignedToWorker).toHaveLength(1);
      expect(sidekick).toEqual([]);
    }
  });

  it("fails the ticket and says so when the Sidekick can't answer", async () => {
    const { value, sent } = await run(create, { ...toSidekick(), failSidekick: "model down" });

    expect(value.ticket).toMatchObject({ status: "failed", error: "model down" });
    expect(value.events.map((e) => e.type)).toEqual(["created", "assigned", "error"]);
    expect(sent.at(-1)).toMatchObject({
      threadId: "thread-1",
      content: sidekickFailedMessage("model down"),
    });
  });

  it("tells the thread when a follow-up can't be answered", async () => {
    const { sent } = await run(
      Effect.gen(function* () {
        yield* handleInbound(msg(), config);
        yield* handleInbound(msg({ externalId: "m2", threadId: "thread-1" }), config);
      }),
      { ...toSidekick(), failSidekick: "model down" },
    );
    expect(sent.at(-1)?.content).toBe(sidekickFailedMessage("model down"));
  });

  it("answers an email request in the channel, since email has no threads", async () => {
    const { sent } = await run(
      Effect.gen(function* () {
        yield* (yield* ProjectSourceRepository).insert(
          source({ id: "s2", type: "email_address", externalId: "a@b.c" }),
        );
        return yield* handleInbound(
          msg({ channelType: "email", channelId: "a@b.c", content: "list my drive" }),
          config,
        );
      }),
      toSidekick(),
    );
    expect(sent).toMatchObject([{ channelType: "email", channelId: "a@b.c" }]);
    expect(sent[0]?.threadId).toBeUndefined();
  });

  it("keeps talking to the Sidekick in the thread of a finished Sidekick ticket", async () => {
    const { value, sent, sidekick } = await run(
      Effect.gen(function* () {
        const first = yield* handleInbound(msg({ content: "list my drive" }), config);
        if (first.kind !== "ticket_created") throw new Error(first.kind);
        const second = yield* handleInbound(
          msg({ externalId: "m2", threadId: "thread-1", content: "and in the shared folder?" }),
          config,
        );
        return { second, got: yield* getTicket({ ticketId: first.ticket.id }) };
      }),
      toSidekick(),
    );

    expect(value.second).toEqual({ kind: "sidekick_answered", ticketId: value.got.ticket.id });
    expect(value.got.ticket.status).toBe("completed");
    expect(value.got.events.map((e) => e.type)).toEqual([
      "created",
      "assigned",
      "result",
      "follow_up",
    ]);
    expect(sidekick.map((c) => [c.prompt, c.requestId])).toEqual([
      ["list my drive", "m1"],
      ["and in the shared folder?", "m2"],
    ]);
    expect(sent.at(-1)).toMatchObject({
      threadId: "thread-1",
      content: "sidekick: and in the shared folder?",
    });
    expect(sent.map((r) => r.content)).not.toContain(TICKET_CLOSED_MESSAGE);
  });

  it("acts as whoever wrote the latest message", async () => {
    const { sidekick, sent } = await run(
      Effect.gen(function* () {
        yield* handleInbound(msg({ sender: { id: "u1" } }), config);
        yield* handleInbound(
          msg({ externalId: "m2", threadId: "thread-1", sender: { id: "u2" }, content: "more" }),
          config,
        );
      }),
      { ...toSidekick(), sidekickProbe: "github" },
      (t) => t.link({ channelType: "discord", id: "u1" }, "github", "tok-u1"),
    );

    expect(sidekick.map((c) => c.token)).toEqual([
      { ok: true, accessToken: "tok-u1" },
      { ok: false, message: "not linked" },
    ]);
    // The unlinked person is asked to /connect, in the project channel.
    expect(sent.at(-2)?.content).toContain("/connect provider:github");
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

describe("project sources", () => {
  it("names a source by the alias given, or derives one that is free in the project", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const named = yield* addSource({
          projectId: "p1",
          type: "google_drive_folder",
          externalId: "1AbCdEfGhIjK",
          name: "Drive folder",
          alias: " Design Docs ",
          description: "  specs and mockups ",
        });
        const fromName = yield* addSource({
          projectId: "p1",
          type: "discord_channel",
          externalId: "c9",
          name: "#Design Docs",
        });
        const fromType = yield* addSource({
          projectId: "p1",
          type: "discord_channel",
          externalId: "c10",
          name: "c10",
        });
        const taken = yield* Effect.flip(
          addSource({
            projectId: "p1",
            type: "github_repo",
            externalId: "acme/web",
            name: "acme/web",
            alias: "design-docs",
          }),
        );
        const invalid = yield* Effect.flip(
          addSource({
            projectId: "p1",
            type: "github_repo",
            externalId: "acme/web",
            name: "acme/web",
            alias: "no good!",
          }),
        );
        return { named, fromName, fromType, taken, invalid };
      }),
    );
    expect(value.named).toMatchObject({ alias: "design-docs", description: "specs and mockups" });
    expect(value.fromName).toMatchObject({ alias: "design-docs-2", description: null });
    expect(value.fromType.alias).toBe("discord");
    expect(value.taken._tag).toBe("SourceAliasTaken");
    expect(value.invalid._tag).toBe("InvalidSourceAlias");
  });

  it("stores a pasted GitHub link as canonical owner/repo and rejects one that isn't a repo", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const pasted = yield* addSource({
          projectId: "p1",
          type: "github_repo",
          externalId: "github.com/Acme/Web.git",
          name: "github.com/Acme/Web.git",
          alias: "web",
        });
        const again = yield* Effect.flip(
          addSource({
            projectId: "p1",
            type: "github_repo",
            externalId: "https://www.github.com/acme/web/",
            name: "the web repo",
            alias: "web-2",
          }),
        );
        const broken = yield* Effect.flip(
          addSource({
            projectId: "p1",
            type: "github_repo",
            externalId: "gitlab.com/acme/web",
            name: "x",
            alias: "gl",
          }),
        );
        return { pasted, again, broken };
      }),
    );
    expect(value.pasted).toMatchObject({ externalId: "acme/web", name: "acme/web" });
    expect(value.again._tag).toBe("SourceAlreadyLinked");
    expect(value.broken).toMatchObject({
      _tag: "InvalidSourceLink",
      externalId: "gitlab.com/acme/web",
    });
  });

  it("updates alias and description, and lists active sources the way Workers see them", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const repo = yield* addSource({
          projectId: "p1",
          type: "github_repo",
          externalId: "acme/web",
          name: "acme/web",
          alias: "web",
        });
        yield* updateSource({
          projectId: "p1",
          sourceId: repo.id,
          alias: "Marketing Site",
          description: "the public website",
        });
        const blank = yield* updateSource({ projectId: "p1", sourceId: repo.id, description: " " });
        yield* updateSource({
          projectId: "p1",
          sourceId: repo.id,
          description: "the public website",
        });
        const bad = yield* Effect.flip(
          updateSource({ projectId: "p1", sourceId: repo.id, alias: "-" }),
        );
        const listed = yield* listProjectSources({ projectId: "p1" });
        const missing = yield* Effect.flip(listProjectSources({ projectId: "nope" }));
        return { blank, bad, listed, missing };
      }),
    );
    expect(value.blank).toMatchObject({ alias: "marketing-site", description: null });
    expect(value.bad._tag).toBe("InvalidSourceAlias");
    expect(value.listed).toContainEqual({
      alias: "marketing-site",
      description: "the public website",
      type: "github_repo",
      externalId: "acme/web",
      name: "acme/web",
      url: "https://github.com/acme/web",
    });
    expect(value.missing._tag).toBe("ProjectNotFound");
  });
});

describe("removeSource", () => {
  it("unlinks a source so Workers stop seeing it, and 404s a source of another project", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const repo = yield* addSource({
          projectId: "p1",
          type: "github_repo",
          externalId: "acme/web",
          name: "acme/web",
          alias: "web",
        });
        const foreign = yield* Effect.flip(removeSource({ projectId: "p2", sourceId: repo.id }));
        const removed = yield* removeSource({ projectId: "p1", sourceId: repo.id });
        const listed = yield* listProjectSources({ projectId: "p1" });
        return { foreign, removed, listed };
      }),
    );
    expect(value.foreign._tag).toBe("SourceNotFound");
    expect(value.removed).toMatchObject({ alias: "web", externalId: "acme/web" });
    expect(value.listed.map((s) => s.alias)).not.toContain("web");
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
        yield* heartbeat({ workerId: "w1", workerType: "local", ticketId: "t9" });
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
        const a = yield* heartbeat({ workerId: "w1", workerType: "local" });
        const b = yield* heartbeat({ workerId: "w1", workerType: "local", ticketId: "t1" });
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

  it("sends the composed reply to the ticket's thread when it has one", async () => {
    const { sent } = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket({ status: "completed", result: "done" }));
        yield* repo.linkThread({
          ticketId: "t1",
          channelType: "discord",
          channelId: "chan-1",
          threadId: "th1",
          createdAt: T0,
        });
        return yield* onTicketCompleted({ ticketId: "t1" });
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelType: "discord", channelId: "chan-1", threadId: "th1" });
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

describe("my tickets", () => {
  const ada = { channelType: "discord", id: "u-ada" } as const;
  const said = (ticketId: string, type: "created" | "follow_up", sender: string, at: string) =>
    Effect.flatMap(TicketRepository, (repo) =>
      repo.appendEvent({
        id: `${ticketId}-${type}-${sender}`,
        ticketId,
        type,
        actor: "coordinator",
        actorId: sender,
        body: "hi",
        payload: { sender: { id: sender }, channelType: "discord" },
        createdAt: at,
      }),
    );

  const seed = Effect.gen(function* () {
    const repo = yield* TicketRepository;
    yield* repo.insert(ticket({ id: "asked", requester: ada }));
    yield* repo.insert(
      ticket({ id: "joined", requester: { channelType: "discord", id: "u-bob" } }),
    );
    yield* said("joined", "created", "u-bob", T0);
    yield* said("joined", "follow_up", "u-ada", "2026-11-04T00:05:00.000Z");
    yield* repo.insert(ticket({ id: "bobs", requester: { channelType: "discord", id: "u-bob" } }));
    yield* said("bobs", "created", "u-bob", T0);
  });

  it("lists the tickets someone asked for or wrote in, with their projects' names", async () => {
    const { value } = await run(Effect.andThen(seed, listMyTickets(ada)));
    expect(value.tickets.map((t) => t.id)).toEqual(["joined", "asked"]);
    expect(value.projects).toEqual([{ id: "p1", name: project.name }]);
  });

  it("opens only a ticket the person is involved in, and 404s the rest", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* seed;
        const mine = yield* getMyTicket("joined", ada);
        const theirs = yield* Effect.flip(getMyTicket("bobs", ada));
        return { mine: mine.ticket.id, theirs: theirs._tag };
      }),
    );
    expect(value).toEqual({ mine: "joined", theirs: "TicketNotFound" });
  });
});
