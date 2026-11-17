import {
  answerScopePrompt,
  askOnTicket,
  askPrompt,
  getTicket,
  handleInbound,
  heartbeat,
  IntentClassifier,
  type IntentResult,
  KeyValueStore,
  NEW_TICKET_OPTION,
  newTicketLinkMessage,
  ProjectRepository,
  ProjectSourceRepository,
  SAME_TICKET_OPTION,
  SCOPE_PROMPT_QUESTION,
  THREAD_OPENED_MESSAGE,
  TicketRepository,
  TICKET_REOPENED_MESSAGE,
  TICKET_RESUMED_MESSAGE,
  WorkerRepository,
  type Project,
  type Ticket,
} from "@project-os/core";
import type { InboundMessage, PromptAnswer } from "@project-os/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

// A message in a ticket's thread is classified with that ticket as context: small talk on a
// finished ticket does nothing, and clearly different work asks "New ticket or this one?".

const T0 = "2026-11-04T00:00:00.000Z";

const project: Project = {
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "",
  defaultResponseChannelId: null,
  channelDigest: false,
  channelDigestNotify: false,
  status: "active",
  createdBy: null,
  createdAt: T0,
  updatedAt: T0,
};

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  projectId: "p1",
  status: "completed",
  title: "Fix login",
  intent: "new_request",
  inputSummary: "fix the login bug",
  priority: null,
  workerType: "local",
  workerId: "w1",
  requester: { channelType: "discord", id: "u1" },
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: T0,
  lastActivityAt: T0,
  completedAt: T0,
  updatedAt: T0,
  ...over,
});

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  threadId: "th1",
  sender: { id: "u1", name: "Ada" },
  content: "build a billing page",
  raw: {},
  receivedAt: T0,
  ...over,
});

const click = (promptId: string, choice: number): PromptAnswer => ({
  channelType: "discord",
  promptId,
  choice,
  externalId: `click-${choice}`,
  channelId: "chan-1",
  threadId: "th1",
  sender: { id: "u1", name: "Ada" },
});

/** Answers `result` for every message, and records what it was asked with. */
const classifying = (result: IntentResult) => {
  const asked: Array<{ content: string; ticketContext?: string }> = [];
  const layer = Layer.succeed(IntentClassifier, {
    classify: (input) =>
      Effect.sync(() => {
        asked.push(input);
        return result;
      }),
  });
  return { asked, layer };
};

const outOfScope: IntentResult = {
  intent: "new_request",
  confidence: 0.9,
  scope: { choice: "out_of_scope", confidence: 0.9 },
};

const setup = (status: Ticket["status"]) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).insert(project);
    yield* (yield* ProjectSourceRepository).insert({
      id: "s1",
      projectId: "p1",
      type: "discord_channel",
      externalId: "chan-1",
      name: "#general",
      alias: "src-s1",
      description: null,
      direction: "both",
      isDefaultResponse: true,
      config: {},
      status: "active",
      connectedBy: null,
      createdAt: T0,
      updatedAt: T0,
    });
    yield* (yield* WorkerRepository).register({
      id: "w1",
      workerType: "local",
      owner: null,
      name: "w1",
      secretHash: "hash-w1",
      at: T0,
    });
    yield* heartbeat({ workerId: "w1", workerType: "local" });
    const repo = yield* TicketRepository;
    yield* repo.insert(ticket({ status }));
    yield* repo.appendEvent({
      id: "e-result",
      ticketId: "t1",
      type: "result",
      actor: "worker",
      actorId: "w1",
      body: "Fixed the redirect loop in #12",
      payload: null,
      createdAt: T0,
    });
    yield* repo.linkThread({
      ticketId: "t1",
      channelType: "discord",
      channelId: "chan-1",
      threadId: "th1",
      createdAt: T0,
    });
  });

const run = <A, E>(
  eff: Effect.Effect<A, E, any>,
  result: IntentResult,
  options: { status?: Ticket["status"]; failPrompt?: string } = {},
) => {
  const classifier = classifying(result);
  const t = makeTestLayer({
    classifier: classifier.layer,
    ...(options.failPrompt === undefined ? {} : { failPrompt: options.failPrompt }),
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* setup(options.status ?? "completed");
      return yield* eff;
    }).pipe(Effect.provide(t.layer)) as Effect.Effect<A, E>,
  ).then((value) => ({ value, t, asked: classifier.asked }));
};

describe("thread messages, classified with their ticket", () => {
  it("gives the classifier the ticket's title, ask, status and last result", async () => {
    const { asked } = await run(handleInbound(msg(), {}), {
      intent: "follow_up",
      confidence: 0.9,
      scope: { choice: "in_scope", confidence: 0.9 },
    });
    expect(asked[0]!.ticketContext).toBe(
      "Ticket: Fix login\nStatus: completed\nAsked: fix the login bug\nLast result: Fixed the redirect loop in #12",
    );
  });

  it("does nothing with small talk on a finished ticket", async () => {
    const { value, t } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(msg({ content: "thanks!" }), {});
        return { out, status: (yield* getTicket({ ticketId: "t1" })).ticket.status };
      }),
      { intent: "chit_chat", confidence: 0.9 },
    );
    expect(value).toEqual({
      out: { kind: "chit_chat_ignored", ticketId: "t1" },
      status: "completed",
    });
    expect(t.sent).toEqual([]);
  });

  it("still passes small talk on to a running ticket", async () => {
    const { value } = await run(
      handleInbound(msg({ content: "thanks!" }), {}),
      { intent: "chit_chat", confidence: 0.9 },
      { status: "in_progress" },
    );
    expect(value).toEqual({ kind: "follow_up_added", ticketId: "t1" });
  });

  it("keeps a message on the ticket when the classifier isn't sure it's different work", async () => {
    const { value } = await run(
      handleInbound(msg(), {}),
      { ...outOfScope, scope: { choice: "out_of_scope", confidence: 0.2 } },
      { status: "in_progress" },
    );
    expect(value).toEqual({ kind: "follow_up_added", ticketId: "t1" });
  });

  it("asks with buttons when a message is clearly different work, and changes nothing yet", async () => {
    const { value, t } = await run(
      Effect.gen(function* () {
        const out = yield* handleInbound(msg(), {});
        const { ticket, events } = yield* getTicket({ ticketId: "t1" });
        return { out, status: ticket.status, types: events.map((e) => e.type) };
      }),
      outOfScope,
    );
    expect(value.out).toMatchObject({ kind: "scope_asked", ticketId: "t1" });
    expect(value.status).toBe("completed");
    expect(value.types).toEqual(["result"]);
    expect(t.prompts).toEqual([
      expect.objectContaining({
        threadId: "th1",
        kind: "choice",
        options: [NEW_TICKET_OPTION, SAME_TICKET_OPTION],
        content: expect.stringContaining(SCOPE_PROMPT_QUESTION),
      }),
    ]);
  });

  it("“New ticket” opens one in a new thread and links it from the old one", async () => {
    const { value, t } = await run(
      Effect.gen(function* () {
        const asked = yield* handleInbound(msg(), {});
        const promptId = (asked as { promptId: string }).promptId;
        const replied = yield* answerScopePrompt(click(promptId, 0), {}, {});
        const all = yield* (yield* TicketRepository).listByStatus(["assigned", "completed"]);
        const again = yield* answerScopePrompt(click(promptId, 1), {}, {});
        return { replied, again, all };
      }),
      outOfScope,
    );
    expect(value.replied.accepted).toBe(true);
    expect(value.again.accepted).toBe(false);
    const created = value.all.find((x) => x.id !== "t1")!;
    expect(created).toMatchObject({ title: "build a billing page", status: "assigned" });
    expect(value.all.find((x) => x.id === "t1")!.status).toBe("completed");
    // No starter message: the request was said inside another thread.
    expect(t.createdThreads).toEqual([
      { channelType: "discord", channelId: "chan-1", name: "build a billing page" },
    ]);
    expect(t.sent).toEqual([
      {
        channelType: "discord",
        channelId: "chan-1",
        threadId: "thread-1",
        content: `New ticket from <#th1>:\n> build a billing page\n\n${THREAD_OPENED_MESSAGE}`,
      },
      {
        channelType: "discord",
        channelId: "chan-1",
        threadId: "th1",
        content: newTicketLinkMessage("thread-1"),
      },
    ]);
  });

  it("“Part of this ticket” adds it to the ticket and reopens a finished one", async () => {
    const { value, t } = await run(
      Effect.gen(function* () {
        const asked = yield* handleInbound(msg(), {});
        yield* answerScopePrompt(click((asked as { promptId: string }).promptId, 1), {}, {});
        const { ticket, events } = yield* getTicket({ ticketId: "t1" });
        return { status: ticket.status, types: events.map((e) => e.type) };
      }),
      outOfScope,
    );
    expect(value.status).toBe("assigned");
    expect(value.types).toContain("follow_up");
    expect(t.sent.map((s) => s.content)).toContain(TICKET_REOPENED_MESSAGE);
    expect(t.createdThreads).toEqual([]);
  });

  it("keeps the message on the ticket when the buttons can't be posted", async () => {
    const { value } = await run(handleInbound(msg(), {}), outOfScope, {
      status: "in_progress",
      failPrompt: "Missing Permissions",
    });
    expect(value).toEqual({ kind: "follow_up_added", ticketId: "t1" });
  });

  it("leaves other prompts' clicks, and a scope answer it can't read, as plain answers", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const asked = yield* handleInbound(msg(), {});
        const promptId = (asked as { promptId: string }).promptId;
        yield* (yield* KeyValueStore).set(`scope-ask:${promptId}`, "not json");
        const garbled = yield* answerScopePrompt(click(promptId, 0), {}, {});
        const missing = yield* answerScopePrompt(click("nope", 0), {}, {});
        const all = yield* (yield* TicketRepository).listByStatus(["open", "assigned"]);
        return { garbled, missing, created: all.length };
      }),
      outOfScope,
    );
    expect(value.garbled.accepted).toBe(true);
    expect(value.missing.accepted).toBe(false);
    expect(value.created).toBe(0);
  });
});

describe("answers to a blocked ticket's question", () => {
  const followUp: IntentResult = { intent: "follow_up", confidence: 0.9 };
  const ask = (ticketId = "t1") =>
    Effect.map(askOnTicket({ ticketId, kind: "approval", question: "Deploy now?" }), (p) => p.id);

  it("resumes the ticket and tells its thread", async () => {
    const { value, t } = await run(
      Effect.gen(function* () {
        const promptId = yield* ask();
        const replied = yield* answerScopePrompt(click(promptId, 0), {}, {});
        const { ticket: after, events } = yield* getTicket({ ticketId: "t1" });
        return { replied, after, events };
      }),
      followUp,
      { status: "blocked" },
    );
    expect(value.replied.accepted).toBe(true);
    expect(value.after).toMatchObject({ status: "assigned", workerId: "w1" });
    expect(value.events.map((e) => e.body)).toContain("Resumed by a follow-up (was blocked)");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th1", content: TICKET_RESUMED_MESSAGE });
  });

  it("says it is queued when no worker is free", async () => {
    const { t } = await run(
      Effect.gen(function* () {
        const promptId = yield* ask();
        yield* (yield* WorkerRepository).remove("w1");
        yield* answerScopePrompt(click(promptId, 0), {}, {});
      }),
      followUp,
      { status: "blocked" },
    );
    expect(t.sent.at(-1)!.content).toMatch(/^Picking this back up\. No worker is free/);
  });

  it("only records the answer on a ticket that isn't blocked, or a prompt with no ticket", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const onTicket = yield* ask();
        const loose = yield* askPrompt({
          target: { channelType: "discord", channelId: "chan-1" },
          kind: "approval",
          question: "Ok?",
        });
        yield* answerScopePrompt(click(onTicket, 0), {}, {});
        yield* answerScopePrompt(click(loose.id, 0), {}, {});
        return (yield* getTicket({ ticketId: "t1" })).ticket;
      }),
      followUp,
      { status: "in_progress" },
    );
    expect(value).toMatchObject({ status: "in_progress", workerId: "w1" });
  });

  it("keeps the answer when the resume fails or loses a race", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const gone = yield* ask();
        const raced = yield* ask();
        const repo = yield* TicketRepository;
        const missing = yield* answerScopePrompt(click(gone, 0), {}, {}).pipe(
          Effect.updateService(TicketRepository, (r) => ({
            ...r,
            get: (id: string) => Effect.flatMap(r.get(id), () => r.get("nope")),
          })),
        );
        const lost = yield* answerScopePrompt(click(raced, 0), {}, {}).pipe(
          Effect.updateService(TicketRepository, (r) => ({
            ...r,
            reopen: (id: string, at: string) =>
              Effect.andThen(
                r.reopen(id, at),
                Effect.suspend(() => r.reopen(id, at)),
              ),
          })),
        );
        return { missing, lost, after: yield* repo.get("t1") };
      }),
      followUp,
      { status: "blocked" },
    );
    expect(value.missing.accepted).toBe(true);
    expect(value.lost.accepted).toBe(true);
    expect(value.after.status).toBe("open");
  });
});
