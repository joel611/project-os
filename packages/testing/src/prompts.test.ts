import {
  answerPrompt,
  askOnTicket,
  askPrompt,
  ChannelGateway,
  EXPIRED_PROMPT_MESSAGE,
  getPrompt,
  KeyValueStore,
  NOT_AN_ADMIN_MESSAGE,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
  UNAVAILABLE_OPTION_MESSAGE,
  type Project,
  type Ticket,
} from "@project-os/core";
import type { PromptAnswer } from "@project-os/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

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

const ticket: Ticket = {
  id: "t1",
  projectId: "p1",
  status: "in_progress",
  title: "Deploy",
  intent: null,
  inputSummary: "Deploy",
  priority: null,
  workerType: "local",
  workerId: "w1",
  requester: null,
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: T0,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
};

const setup = (withSource: boolean) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).insert(project);
    yield* (yield* TicketRepository).insert(ticket);
    if (!withSource) return;
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
  });

const run = <A, E>(eff: Effect.Effect<A, E, any>, options: { source?: boolean } = {}) => {
  const t = makeTestLayer();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* setup(options.source ?? true);
      return yield* eff;
    }).pipe(Effect.provide(t.layer)) as Effect.Effect<A, E>,
  ).then((value) => ({ value, prompts: t.prompts }));
};

const click = (
  promptId: string,
  choice: number,
  over: Partial<PromptAnswer> = {},
): PromptAnswer => ({
  channelType: "discord",
  promptId,
  choice,
  externalId: `click-${choice}`,
  channelId: "chan-1",
  sender: { id: "u1", name: "Ada" },
  ...over,
});

describe("askOnTicket", () => {
  it("posts in the project's default channel when the ticket has no thread", async () => {
    const { value, prompts } = await run(
      askOnTicket({ ticketId: "t1", kind: "approval", question: "Deploy now?" }),
    );
    expect(prompts).toEqual([
      {
        channelType: "discord",
        channelId: "chan-1",
        promptId: value.id,
        kind: "approval",
        content: "**Approval needed**\nDeploy now?",
        options: ["Approve", "Deny"],
      },
    ]);
    expect(value).toMatchObject({ ticketId: "t1", status: "pending", messageId: "prompt-msg-1" });
  });

  it("posts in the ticket's thread when it has one", async () => {
    const { prompts } = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).linkThread({
          ticketId: "t1",
          channelType: "discord",
          channelId: "chan-1",
          threadId: "th-1",
          createdAt: T0,
        });
        return yield* askOnTicket({ ticketId: "t1", kind: "approval", question: "Deploy?" });
      }),
    );
    expect(prompts[0]).toMatchObject({ channelId: "chan-1", threadId: "th-1" });
  });

  it("fails with NoPromptChannel when there's nowhere to ask", async () => {
    const out = await run(
      askOnTicket({ ticketId: "t1", kind: "approval", question: "Deploy?" }).pipe(Effect.flip),
      { source: false },
    );
    expect(out.value._tag).toBe("NoPromptChannel");
    expect(out.prompts).toEqual([]);
  });

  it.each([
    [["one"], "at least 2"],
    [Array.from({ length: 26 }, (_, i) => `o${i}`), "at most 25"],
    [["a", "x".repeat(101)], "1 to 100"],
    [["a", "a"], "different"],
  ])("refuses choice options %#", async (options, message) => {
    const out = await run(
      askOnTicket({ ticketId: "t1", kind: "choice", question: "Pick", options }).pipe(Effect.flip),
    );
    expect(out.value).toMatchObject({ _tag: "InvalidPrompt" });
    expect((out.value as { message: string }).message).toContain(message);
  });
});

describe("askPrompt", () => {
  it("keeps the posted prompt even if it was forgotten while posting", async () => {
    // The adapter call takes long enough for the stored prompt to go (TTL, eviction).
    const forgetful = Layer.effect(
      ChannelGateway,
      Effect.gen(function* () {
        const kv = yield* KeyValueStore;
        const gateway = yield* ChannelGateway;
        return {
          ...gateway,
          ask: (r) => Effect.as(kv.delete(`prompt:${r.promptId}`), { messageId: "m9" }),
        };
      }),
    );
    const { value } = await run(
      Effect.gen(function* () {
        const prompt = yield* askPrompt({
          target: { channelType: "discord", channelId: "chan-1" },
          kind: "approval",
          question: "Ship?",
        });
        return yield* getPrompt({ promptId: prompt.id });
      }).pipe(Effect.provide(forgetful)),
    );
    expect(value).toMatchObject({ status: "pending", messageId: "m9" });
  });

  it("fails with PromptNotFound for an unknown prompt", async () => {
    const { value } = await run(Effect.flip(getPrompt({ promptId: "nope" })));
    expect(value._tag).toBe("PromptNotFound");
  });
});

describe("answerPrompt", () => {
  const ask = askOnTicket({
    ticketId: "t1",
    kind: "choice",
    question: "Which region?",
    options: ["EU", "US"],
  });

  it("records the first answer, logs it on the ticket, and refuses later ones", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const prompt = yield* ask;
        const first = yield* answerPrompt(click(prompt.id, 1));
        const second = yield* answerPrompt(click(prompt.id, 0, { sender: { id: "u2" } }));
        const stored = yield* getPrompt({ promptId: prompt.id });
        const events = yield* (yield* TicketRepository).listEvents("t1");
        return { first, second, stored, events };
      }),
    );
    expect(value.first).toEqual({
      accepted: true,
      content: "**Question**\nWhich region?\n\n☑️ Ada chose **US**",
    });
    expect(value.second.accepted).toBe(false);
    expect(value.second.content).toContain("Already answered");
    expect(value.stored.answer).toMatchObject({ choice: 1, label: "US", by: { id: "u1" } });
    expect(value.events.filter((e) => e.type === "follow_up")).toEqual([
      expect.objectContaining({ actorId: "u1", body: 'Answer to "Which region?": US' }),
    ]);
  });

  it("says a prompt it doesn't know has expired", async () => {
    const { value } = await run(answerPrompt(click("missing", 0)));
    expect(value).toEqual({ accepted: false, content: EXPIRED_PROMPT_MESSAGE });
  });

  it("ignores a click claiming another channel", async () => {
    const { value } = await run(
      Effect.flatMap(ask, (p) => answerPrompt(click(p.id, 0, { channelId: "elsewhere" }))),
    );
    expect(value.content).toBe(EXPIRED_PROMPT_MESSAGE);
  });

  it("forgets an unreadable stored prompt", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        yield* (yield* KeyValueStore).set("prompt:bad", "not json");
        return yield* answerPrompt(click("bad", 0));
      }),
    );
    expect(value.content).toBe(EXPIRED_PROMPT_MESSAGE);
  });

  it("loses a same-instant race to another click", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const prompt = yield* ask;
        yield* (yield* KeyValueStore).setIfAbsent(`prompt-answer:${prompt.id}`, "other-click");
        return yield* answerPrompt(click(prompt.id, 0));
      }),
    );
    expect(value).toEqual({ accepted: false, content: "Someone else answered first." });
  });

  it("still records the answer when the ticket is gone", async () => {
    const { value } = await run(
      Effect.gen(function* () {
        const prompt = yield* askPrompt({
          target: { channelType: "discord", channelId: "chan-1" },
          kind: "approval",
          question: "Ship?",
          ticketId: "gone",
        });
        // A sender without a display name is mentioned instead.
        const reply = yield* answerPrompt(click(prompt.id, 0, { sender: { id: "u9" } }));
        return { reply, stored: yield* getPrompt({ promptId: prompt.id }) };
      }),
    );
    expect(value.stored.status).toBe("answered");
    expect(value.reply.content).toContain("✅ Approved by <@u9>");
  });

  it("refuses an option that isn't there", async () => {
    const { value } = await run(Effect.flatMap(ask, (p) => answerPrompt(click(p.id, 5))));
    expect(value).toEqual({ accepted: false, content: UNAVAILABLE_OPTION_MESSAGE });
  });

  it("only lets admins answer in the admin channel", async () => {
    const config = { adminChannelId: ADMIN, adminUserIds: ["boss"] };
    const { value } = await run(
      Effect.gen(function* () {
        const prompt = yield* askPrompt({
          target: { channelType: "discord", channelId: ADMIN },
          kind: "approval",
          question: "Delete project Acme?",
        });
        const at = { channelId: ADMIN };
        const stranger = yield* answerPrompt(click(prompt.id, 0, at), config);
        const boss = yield* answerPrompt(
          click(prompt.id, 1, { ...at, sender: { id: "boss", name: "Boss" } }),
          config,
        );
        return { stranger, boss };
      }),
    );
    expect(value.stranger).toEqual({ accepted: false, content: NOT_AN_ADMIN_MESSAGE });
    expect(value.boss).toEqual({
      accepted: true,
      content: "**Approval needed**\nDelete project Acme?\n\n❌ Denied by Boss",
    });
  });
});
