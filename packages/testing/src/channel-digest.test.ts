import {
  CHANNEL_DIGEST_AUTHOR,
  ChannelDigester,
  ChannelMessageRepository,
  DEFAULT_CHANNEL_DIGEST,
  digestChannels,
  digestNotice,
  handleInbound,
  KeyValueStore,
  MemoryRepository,
  ProjectRepository,
  ProjectSourceRepository,
  recordChannelMessage,
  type Project,
} from "@project-os/core";
import type { ChannelMessage, InboundMessage } from "@project-os/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "Web shop",
  defaultResponseChannelId: null,
  channelDigest: true,
  channelDigestNotify: false,
  status: "active",
  createdBy: null,
  createdAt: ago(1000),
  updatedAt: ago(1000),
  ...over,
});

const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "chan-1",
  sender: { id: "u1", name: "Ada" },
  content: "we decided to use SQLite",
  mentionsBot: false,
  raw: {},
  receivedAt: ago(60),
  ...over,
});

const message = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: `c-${over.externalId ?? "m1"}`,
  projectId: "p1",
  channelType: "discord",
  channelId: "chan-1",
  threadId: null,
  externalId: "m1",
  senderId: "u1",
  senderName: "Ada",
  content: "we decided to use SQLite",
  url: null,
  sentAt: ago(60),
  ...over,
});

const setup = (options: { project?: Partial<Project>; failDigest?: string } = {}) => {
  const t = makeTestLayer({
    now: NOW,
    ...(options.failDigest === undefined ? {} : { failDigest: options.failDigest }),
  });
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(project(options.project));
        return yield* effect;
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<A, E, never>,
    );
  return { ...t, run };
};

const add = (...messages: ChannelMessage[]) =>
  Effect.gen(function* () {
    const repo = yield* ChannelMessageRepository;
    for (const m of messages) yield* repo.append(m);
  });

const memory = Effect.flatMap(MemoryRepository, (r) => r.list("p1"));
const waiting = Effect.flatMap(ChannelMessageRepository, (r) => r.list("p1", 100));

describe("recordChannelMessage", () => {
  it("keeps a message with its link, once, and skips one with no text", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        const first = yield* recordChannelMessage(
          inbound({ threadId: "th", url: "https://discord.test/m1" }),
          "p1",
        );
        const again = yield* recordChannelMessage(inbound(), "p1");
        const empty = yield* recordChannelMessage(
          inbound({ externalId: "m2", content: "  " }),
          "p1",
        );
        const nameless = yield* recordChannelMessage(
          inbound({ externalId: "m3", sender: { id: "u9" } }),
          "p1",
        );
        return { first, again, empty, nameless, rows: yield* waiting };
      }),
    );
    expect([out.first, out.again, out.empty, out.nameless]).toEqual([true, false, false, true]);
    expect(out.rows).toEqual([
      expect.objectContaining({ externalId: "m1", threadId: "th", url: "https://discord.test/m1" }),
      expect.objectContaining({ externalId: "m3", senderName: null, url: null }),
    ]);
  });
});

describe("handleInbound and the Channel Digest", () => {
  const linked = Effect.gen(function* () {
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
      createdAt: ago(1000),
      updatedAt: ago(1000),
    });
  });
  const config = { requireMention: true, channelDigest: true };

  it("keeps unmentioned chatter in a project that has the digest on", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* linked;
        const outcome = yield* handleInbound(inbound(), config);
        return { outcome, rows: yield* waiting };
      }),
    );
    expect(out.outcome).toEqual({ kind: "not_mentioned" });
    expect(out.rows).toHaveLength(1);
  });

  it("keeps nothing when the project or the server has it off", async () => {
    const off = setup({ project: { channelDigest: false } });
    expect(
      await off.run(
        Effect.gen(function* () {
          yield* linked;
          yield* handleInbound(inbound(), config);
          return yield* waiting;
        }),
      ),
    ).toEqual([]);
    const server = setup();
    expect(
      await server.run(
        Effect.gen(function* () {
          yield* linked;
          yield* handleInbound(inbound(), { requireMention: true });
          return yield* waiting;
        }),
      ),
    ).toEqual([]);
  });
});

describe("digestChannels", () => {
  it("saves each point with its source messages, most relevant first, silently", async () => {
    const t = setup();
    const long = `we decided ${"x".repeat(600)}`;
    const out = await t.run(
      Effect.gen(function* () {
        yield* add(
          message({ externalId: "m1", content: "SQLite or Postgres?", sentAt: ago(62) }),
          message({
            externalId: "m2",
            content: long,
            senderName: null,
            senderId: "u2",
            threadId: "th",
            url: "https://discord.test/m2",
            sentAt: ago(61),
          }),
        );
        const runs = yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
        return { runs, saved: yield* memory, left: yield* waiting };
      }),
    );
    expect(out.runs).toEqual([{ projectId: "p1", messages: 2, saved: 1 }]);
    expect(t.digestCalls[0]).toMatchObject({
      projectName: "Acme",
      projectContext: "Web shop",
      known: [],
      messages: [
        { id: "m1", sender: "Ada" },
        { id: "m2", sender: "u2", threadId: "th" },
      ],
    });
    expect(out.saved).toEqual([
      expect.objectContaining({
        type: "decision",
        title: long.slice(0, 80),
        createdBy: CHANNEL_DIGEST_AUTHOR,
        sourceMetadata: {
          source: "channel_digest",
          channelType: "discord",
          channelId: "chan-1",
          messages: [
            {
              id: "m2",
              sender: "u2",
              senderId: "u2",
              sentAt: ago(61),
              threadId: "th",
              url: "https://discord.test/m2",
              quote: `${long.slice(0, 499)}…`,
            },
          ],
        },
      }),
    ]);
    expect(out.left).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("posts what it saved when the project asks for it, and nothing when it found nothing", async () => {
    const t = setup({ project: { channelDigestNotify: true } });
    await t.run(
      Effect.gen(function* () {
        yield* add(message({ content: "lunch?" }));
        yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
        yield* add(message({ externalId: "m2", content: "remember: deploys on Friday" }));
        yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
      }),
    );
    expect(t.sent).toEqual([
      {
        channelType: "discord",
        channelId: "chan-1",
        content: digestNotice([{ type: "note", title: "remember: deploys on Friday" }]),
      },
    ]);
  });

  it("waits for a quiet channel unless the oldest message has waited long enough", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* add(message({ sentAt: ago(400) }), message({ externalId: "m2", sentAt: ago(1) }));
        const busy = yield* digestChannels({ ...DEFAULT_CHANNEL_DIGEST, maxWaitMs: 500 * 60_000 });
        const waited = yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
        return { busy, waited };
      }),
    );
    expect(out.busy).toEqual([]);
    expect(out.waited).toEqual([{ projectId: "p1", messages: 2, saved: 2 }]);
  });

  it("drops what a project turned off kept, and messages past retention", async () => {
    const t = setup({ project: { channelDigest: false } });
    const out = await t.run(
      Effect.gen(function* () {
        yield* add(message(), message({ externalId: "old", sentAt: ago(8 * 24 * 60) }));
        const runs = yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
        return { runs, left: yield* waiting };
      }),
    );
    expect(out.runs).toEqual([{ projectId: "p1", messages: 0, saved: 0 }]);
    expect(out.left).toEqual([]);
    expect(t.digestCalls).toEqual([]);
  });

  it("keeps the messages when the model fails, and retries only after a pause", async () => {
    const t = setup({ failDigest: "provider down" });
    const out = await t.run(
      Effect.gen(function* () {
        yield* add(message());
        const first = yield* digestChannels({ ...DEFAULT_CHANNEL_DIGEST, retryAfterMs: 1000 });
        const second = yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
        const kv = yield* KeyValueStore;
        yield* kv.delete("digest:retry:p1");
        const third = yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
        return { first, second, third, left: yield* waiting };
      }),
    );
    expect(out.first).toEqual([{ projectId: "p1", messages: 0, saved: 0, error: "provider down" }]);
    expect(out.second).toEqual([]);
    expect(out.third).toHaveLength(1);
    expect(out.left).toHaveLength(1);
  });

  it("quotes each source message once, and only ones it was shown", async () => {
    const t = setup();
    const saved = await t.run(
      Effect.gen(function* () {
        yield* add(message());
        yield* digestChannels(DEFAULT_CHANNEL_DIGEST).pipe(
          Effect.provide(
            Layer.succeed(ChannelDigester, {
              digest: () =>
                Effect.succeed([
                  {
                    type: "note",
                    title: "SQLite",
                    content: "SQLite.",
                    messageIds: ["m1", "x", "m1"],
                  },
                ]),
            }),
          ),
        );
        return yield* memory;
      }),
    );
    expect((saved[0]!.sourceMetadata as any).messages.map((m: any) => m.id)).toEqual(["m1"]);
  });

  it("skips a project another run is digesting", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* add(message());
        yield* (yield* KeyValueStore).set("digest:lock:p1", "1");
        return yield* digestChannels(DEFAULT_CHANNEL_DIGEST);
      }),
    );
    expect(out).toEqual([]);
    expect(t.digestCalls).toEqual([]);
  });
});
