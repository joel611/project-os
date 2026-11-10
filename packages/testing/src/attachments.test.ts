import {
  assetKey,
  handleInbound,
  listTicketAttachments,
  ProjectSourceRepository,
  ProjectRepository,
  TicketRepository,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const file = (over: Partial<NonNullable<InboundMessage["attachments"]>[number]> = {}) => ({
  id: "a1",
  filename: "My Hero?.png",
  contentType: "image/png",
  size: 10,
  url: "https://cdn.discordapp.com/attachments/1/a1/hero.png?hm=x",
  ...over,
});
const message = (attachments: NonNullable<InboundMessage["attachments"]>): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  sender: { id: "u1", name: "Pat" },
  content: "swap the hero",
  mentionsBot: true,
  attachments,
  raw: null,
  receivedAt: T0,
});

const setup = (options: Parameters<typeof makeTestLayer>[0] = {}) => {
  const test = makeTestLayer({ classifier: classifierReturning("new_request"), ...options });
  const runtime = ManagedRuntime.make(test.layer);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    runtime.runPromise(effect as Effect.Effect<A, never, any>) as Promise<A>;
  const seed = Effect.gen(function* () {
    yield* (yield* ProjectRepository).insert({
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
    });
    yield* (yield* ProjectSourceRepository).insert({
      id: "s1",
      projectId: "p1",
      type: "discord_channel",
      externalId: "chan-1",
      name: "#general",
      alias: "chat",
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
  const send = (msg: InboundMessage, config = {}) =>
    run(
      Effect.gen(function* () {
        yield* seed.pipe(Effect.ignore);
        return yield* handleInbound(msg, config);
      }),
    );
  return { test, run, send };
};

const eventsOf = (run: ReturnType<typeof setup>["run"], id: string) =>
  run(
    Effect.gen(function* () {
      return yield* (yield* TicketRepository).listEvents(id);
    }),
  );

const ticketOf = (outcome: Awaited<ReturnType<ReturnType<typeof setup>["send"]>>) =>
  (outcome as { ticket: { id: string } }).ticket.id;

describe("copying attachments at intake", () => {
  it("copies files from Discord's CDN under a safe key and marks them stored", async () => {
    const { test, run, send } = setup();
    const ticketId = ticketOf(await send(message([file()])));

    const key = assetKey(ticketId, file());
    expect(key).toBe(`${ticketId}/a1/My_Hero_.png`);
    expect([...test.storedAssets.keys()]).toEqual([key]);
    const events = await eventsOf(run, ticketId);
    expect((events[0]!.payload as any).attachments).toEqual([
      { id: "a1", filename: "My Hero?.png", contentType: "image/png", size: 10, stored: true },
    ]);
    const listed = await run(listTicketAttachments(ticketId));
    expect(listed).toEqual([
      expect.objectContaining({ id: "a1", url: `https://assets.test/${key}` }),
    ]);
  });

  it("names a file with nothing usable in its name just `file`", () => {
    expect(assetKey("t", { id: "a", filename: "???" })).toBe("t/a/file");
  });

  it("skips other hosts, malformed URLs and oversize files", async () => {
    const { test, send } = setup();
    await send(
      message([
        file({ id: "a1", url: "https://evil.example/x.png" }),
        file({ id: "a2", url: "not a url" }),
        file({ id: "a3", size: 101 }),
      ]),
      { attachments: { maxBytes: 100 } },
    );
    expect(test.storedAssets.size).toBe(0);
  });

  it("copies from a configured host", async () => {
    const { test, send } = setup();
    await send(message([file({ url: "http://localhost:9/f.png" })]), {
      attachments: { hosts: ["localhost"] },
    });
    expect(test.storedAssets.size).toBe(1);
  });

  it("does not copy files for a tool-only Sidekick request", async () => {
    const { test, send } = setup({ classifier: classifierReturning("new_request", 1, "sidekick") });
    const outcome = await send(message([file()]));
    expect(outcome.kind).toBe("ticket_created");
    expect(test.storedAssets.size).toBe(0);
  });

  it("keeps the ticket and the Discord link when the copy fails", async () => {
    const { test, send, run } = setup({ failAssetStore: "bucket down" });
    const outcome = await send(message([file()]));
    expect(outcome.kind).toBe("ticket_created");
    expect(test.storedAssets.size).toBe(0);
    const events = await eventsOf(run, ticketId(outcome));
    expect((events[0]!.payload as any).attachments[0]).not.toHaveProperty("stored");
  });
});

const ticketId = ticketOf;
