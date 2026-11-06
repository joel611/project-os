import {
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
  workerType: "local_claude",
  workerId: "w1",
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
  options: { readonly calls?: number; readonly replyChannel?: boolean } = {},
) => {
  const t = makeTestLayer();
  for (const [who, provider] of links) {
    const person = typeof who === "string" ? { channelType: "discord" as const, id: who } : who;
    t.link(person, provider, `tok-${person.id}`);
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
      for (const e of events) yield* repo.appendEvent(e);
      const call = Effect.result(userTokenForTicket({ ticketId: "t1", provider: "google" }));
      for (let i = 1; i < (options.calls ?? 1); i++) yield* call;
      return yield* call;
    }).pipe(Effect.provide(t.layer)),
  );
  return { result, sent: t.sent };
};

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
          '<@u-ada>, I need your Google access for "Summarize the Q3 doc". Run `/connect provider:google` and I\'ll carry on.',
      },
    ]);
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
      'ada@example.com, I need your Google access for "Summarize the Q3 doc". Run `/connect provider:google` and I\'ll carry on.',
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
