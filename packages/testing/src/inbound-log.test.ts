import {
  handleInbound,
  InboundLogRepository,
  ProjectRepository,
  ProjectSourceRepository,
  readInbound,
  stripMentions,
  type Project,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const AT = "2026-11-13T00:00:00.000Z";

const project: Project = {
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "Web shop",
  defaultResponseChannelId: null,
  channelDigest: false,
  channelDigestNotify: false,
  status: "active",
  createdBy: null,
  createdAt: AT,
  updatedAt: AT,
};

const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  sender: { id: "u1", name: "Ada" },
  content: "hello team",
  mentionsBot: false,
  raw: {},
  receivedAt: AT,
  ...over,
});

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(project);
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
        createdAt: AT,
        updatedAt: AT,
      });
      return yield* effect;
    }).pipe(Effect.provide(makeTestLayer({ now: new Date(AT) }).layer)) as Effect.Effect<
      A,
      E,
      never
    >,
  );

describe("stripMentions", () => {
  it("removes user, role, channel and everyone mentions", () => {
    expect(stripMentions("<@1> hi <@!2> <@&3> see <#4> @everyone @here ok")).toBe("hi see ok");
  });
});

describe("the inbound log", () => {
  it("records a message the bot ignores, without its mentions, newest first", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ignored = yield* handleInbound(
          inbound({ content: "<@42> fyi", receivedAt: "2026-11-13T00:00:01.000Z" }),
          { requireMention: true },
        );
        yield* handleInbound(inbound({ externalId: "m0", receivedAt: AT }), {
          requireMention: true,
        });
        return { ignored, log: yield* readInbound("p1") };
      }),
    );
    expect(out.ignored).toEqual({ kind: "not_mentioned" });
    expect(out.log.map((e) => [e.externalId, e.content, e.mentionsBot])).toEqual([
      ["m1", "fyi", false],
      ["m0", "hello team", false],
    ]);
  });

  it("skips channels no project is linked to, and a redelivered message", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* handleInbound(inbound({ channelId: "elsewhere", externalId: "x" }), {
          requireMention: true,
        });
        yield* handleInbound(inbound(), { requireMention: true });
        const again = yield* (yield* InboundLogRepository).append({
          id: "dup",
          projectId: "p1",
          channelType: "discord",
          channelId: "chan-1",
          threadId: null,
          externalId: "m1",
          senderId: "u1",
          senderName: null,
          content: "x",
          mentionsBot: false,
          attachmentCount: 0,
          url: null,
          receivedAt: AT,
        });
        return { again, log: yield* readInbound("p1") };
      }),
    );
    expect(out.again).toBe(false);
    expect(out.log).toHaveLength(1);
  });
});
