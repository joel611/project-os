import {
  actingAs,
  AuditLogRepository,
  sharedUseClause,
  type Person,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
  userTokenForTicket,
  type Project,
  type Ticket,
  type TicketEvent,
} from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";

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
  title: "Summarize the Q3 doc",
  intent: null,
  inputSummary: "",
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

const event = (n: number, type: TicketEvent["type"], payload: unknown): TicketEvent => ({
  id: `e${n}`,
  ticketId: "t1",
  type,
  actor: "coordinator",
  actorId: null,
  body: "",
  payload,
  createdAt: `2026-11-04T00:00:0${n}.000Z`,
});

const ada = { id: "u-ada", name: "Ada" };
const bob = { id: "u-bob", name: "Bob" };

const run = async (
  events: TicketEvent[],
  links: Array<[string, "google" | "github"] | [Person, "google" | "github"]>,
  options: {
    readonly calls?: number;
    readonly replyChannel?: boolean;
    readonly thread?: boolean;
    /** Shared accounts assigned to people: a null token is one that stopped working. */
    readonly shared?: Array<[string, string | null]>;
  } = {},
) => {
  const t = makeTestLayer();
  for (const [who, provider] of links) {
    const person = typeof who === "string" ? { channelType: "discord" as const, id: who } : who;
    t.link(person, provider, `tok-${person.id}`);
  }
  const OPS = { id: "sa1", label: "Ops bot", identity: "ops-bot" };
  for (const [id, token] of options.shared ?? []) {
    t.linkShared({ channelType: "discord", id }, "google", OPS, token);
  }
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(project);
      yield* (yield* ProjectSourceRepository).insert({
        id: "s1",
        projectId: "p1",
        type: "discord_channel",
        externalId: "chan-1",
        name: "#acme",
        alias: "acme",
        description: null,
        direction: "both",
        isDefaultResponse: options.replyChannel ?? true,
        config: {},
        status: "active",
        connectedBy: null,
        createdAt: T0,
        updatedAt: T0,
      });
      const repo = yield* TicketRepository;
      yield* repo.insert(ticket);
      if (options.thread) {
        yield* repo.linkThread({
          ticketId: "t1",
          channelType: "discord",
          channelId: "chan-1",
          threadId: "thread-9",
          createdAt: T0,
        });
      }
      for (const e of events) yield* repo.appendEvent(e);
      const call = Effect.result(userTokenForTicket({ ticketId: "t1", provider: "google" }));
      for (let i = 1; i < (options.calls ?? 1); i++) yield* call;
      const result = yield* call;
      const clause = yield* sharedUseClause("t1");
      const { entries } = yield* (yield* AuditLogRepository).list({ limit: 10 });
      return { result, clause, entries };
    }).pipe(Effect.provide(t.layer)),
  );
  return { ...result, sent: t.sent };
};

describe("actingAs", () => {
  it("writes who a Worker acted as: Discord by mention, others by name and id", () => {
    expect(actingAs({ channelType: "discord", id: "u1", name: "Ada" })).toBe("<@u1> (Ada)");
    expect(actingAs({ channelType: "discord", id: "u1" })).toBe("<@u1>");
    expect(actingAs({ channelType: "email", id: "a@b.co", name: "Ada" })).toBe("Ada (a@b.co)");
    expect(actingAs({ channelType: "email", id: "a@b.co" })).toBe("a@b.co");
  });
});

describe("userTokenForTicket with a shared account", () => {
  const created = [event(1, "created", { sender: ada, channelType: "discord" })];

  it("falls back to the assigned shared account and records its use once", async () => {
    const { result, clause, entries } = await run(created, [], {
      shared: [["u-ada", "tok-shared"]],
      calls: 2,
    });
    expect(result).toMatchObject({
      success: {
        accessToken: "tok-shared",
        person: { id: "u-ada" },
        sharedAccount: { id: "sa1", label: "Ops bot", identity: "ops-bot" },
      },
    });
    expect(clause).toBe(', via shared Google account "Ops bot" (ops-bot)');
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "connection",
        action: "shared_account_used",
        ticketId: "t1",
        projectId: "p1",
        summary: 'Ticket acted for <@u-ada> (Ada) with shared Google account "Ops bot" (ops-bot)',
      }),
    ]);
  });

  it("names a shared account without an identity by its label alone", async () => {
    const t = makeTestLayer();
    t.linkShared(
      { channelType: "discord", id: "u-ada" },
      "google",
      { id: "sa2", label: "Team" },
      "x",
    );
    const clause = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(project);
        const repo = yield* TicketRepository;
        yield* repo.insert(ticket);
        yield* repo.appendEvent(created[0]!);
        yield* userTokenForTicket({ ticketId: "t1", provider: "google" });
        return yield* sharedUseClause("t1");
      }).pipe(Effect.provide(t.layer)),
    );
    expect(clause).toBe(', via shared Google account "Team"');
  });

  it("prefers the person's own link", async () => {
    const { result, clause, entries } = await run(created, [["u-ada", "google"]], {
      shared: [["u-ada", "tok-shared"]],
    });
    expect(result).toMatchObject({ success: { accessToken: "tok-u-ada" } });
    expect((result as any).success.sharedAccount).toBeUndefined();
    expect(clause).toBe("");
    expect(entries).toEqual([]);
  });

  it("asks an admin, once a day, to reconnect a shared account that stopped working", async () => {
    const { result, sent } = await run(created, [], { shared: [["u-ada", null]], calls: 2 });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NotConnected", sharedAccount: { label: "Ops bot" } },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(
          /shared Google account "Ops bot" \(ops-bot\).*An admin needs to reconnect it.*acted as <@u-ada> \(Ada\)/s,
        ),
      }),
    ]);
  });

  it("stays quiet when the ticket has nowhere to post", async () => {
    const { sent } = await run(created, [], { shared: [["u-ada", null]], replyChannel: false });
    expect(sent).toEqual([]);
  });
});

describe("userTokenForTicket", () => {
  it("uses the requester's token", async () => {
    const { result } = await run(
      [event(1, "created", { sender: ada, channelType: "discord" })],
      [["u-ada", "google"]],
    );
    expect(result).toMatchObject({
      _tag: "Success",
      success: { accessToken: "tok-u-ada", person: { id: "u-ada", name: "Ada" } },
    });
  });

  it("switches to the latest follow-up author's own token", async () => {
    const { result } = await run(
      [
        event(1, "created", { sender: ada, channelType: "discord" }),
        event(2, "status_update", {}),
        event(3, "follow_up", { sender: bob }),
      ],
      [
        ["u-ada", "google"],
        ["u-bob", "google"],
      ],
    );
    expect(result).toMatchObject({ success: { accessToken: "tok-u-bob" } });
  });

  it("asks an unlinked person to /connect and fails NotConnected", async () => {
    const t = [event(1, "created", { sender: ada, channelType: "discord" })];
    const { result, sent } = await run(t, []);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "NotConnected" } });
    expect(sent).toEqual([
      {
        channelType: "discord",
        channelId: "chan-1",
        content:
          "<@u-ada>, I need your Google access for \"Summarize the Q3 doc\". Run `/connect provider:google`, then reply here and I'll carry on. (The Worker acted as <@u-ada> (Ada), the author of this ticket's latest message.)",
      },
    ]);
  });

  it("asks in the ticket's thread, where the reply resumes it", async () => {
    const t = [event(1, "created", { sender: ada, channelType: "discord" })];
    const { sent } = await run(t, [], { thread: true });
    expect(sent).toEqual([expect.objectContaining({ channelId: "chan-1", threadId: "thread-9" })]);
  });

  it("reads senders without a name or a channel type, skipping malformed events", async () => {
    const email: Person = { channelType: "email", id: "ada@example.com" };
    const { result } = await run(
      [
        event(1, "created", { sender: ada, channelType: "discord" }),
        event(2, "follow_up", { sender: { id: "u-bob" } }),
        event(3, "follow_up", null),
        event(4, "follow_up", { sender: { id: 7 } }),
      ],
      [
        ["u-bob", "google"],
        [email, "google"],
      ],
    );
    expect(result).toMatchObject({
      success: { accessToken: "tok-u-bob", person: { channelType: "discord", name: null } },
    });
  });

  it("asks once per day, addressing non-Discord people by id", async () => {
    const { sent } = await run(
      [event(1, "created", { sender: { id: "ada@example.com" }, channelType: "email" })],
      [],
      { calls: 2 },
    );
    expect(sent.map((s) => s.content)).toEqual([
      "ada@example.com, I need your Google access for \"Summarize the Q3 doc\". Run `/connect provider:google`, then reply here and I'll carry on. (The Worker acted as ada@example.com, the author of this ticket's latest message.)",
    ]);
  });

  it("doesn't ask when the project has no reply channel", async () => {
    const { result, sent } = await run(
      [event(1, "created", { sender: ada, channelType: "discord" })],
      [],
      { replyChannel: false },
    );
    expect(result).toMatchObject({ failure: { _tag: "NotConnected" } });
    expect(sent).toEqual([]);
  });

  it("fails without a human requester", async () => {
    const { result, sent } = await run([event(1, "system", {})], []);
    expect(result).toMatchObject({ failure: { _tag: "NotConnected" } });
    expect(sent).toEqual([]);
  });
});
