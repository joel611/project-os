import {
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

const run = async (events: TicketEvent[], links: Array<[string, "google" | "github"]>) => {
  const t = makeTestLayer();
  for (const [id, provider] of links) t.link({ channelType: "discord", id }, provider, `tok-${id}`);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(project);
      yield* (yield* ProjectSourceRepository).insert({
        id: "s1",
        projectId: "p1",
        type: "discord_channel",
        externalId: "chan-1",
        name: "#acme",
        direction: "both",
        isDefaultResponse: true,
        config: {},
        status: "active",
        connectedBy: null,
        createdAt: T0,
        updatedAt: T0,
      });
      const repo = yield* TicketRepository;
      yield* repo.insert(ticket);
      for (const e of events) yield* repo.appendEvent(e);
      return yield* Effect.result(userTokenForTicket({ ticketId: "t1", provider: "google" }));
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

  it("fails without a human requester", async () => {
    const { result, sent } = await run([event(1, "system", {})], []);
    expect(result).toMatchObject({ failure: { _tag: "NotConnected" } });
    expect(sent).toEqual([]);
  });
});
