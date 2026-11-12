import { CHANNEL_DIGEST_AUTHOR, digestNotice, IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// People talk in a project channel without @mentioning the bot. The Discord adapter forwards
// every message anyway; the Coordinator keeps them, and the Channel Digest (Cron each minute)
// later saves the decisions in them to Project Memory, with the messages they came from.

const CHANNEL = "chan-1";
const GUILD = "guild-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada", guildId: GUILD };
const bob: FakeSpeaker = { channelId: CHANNEL, userId: "u2", name: "Bob", guildId: GUILD };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
afterEach(() => stack.stop());

const chat = async (
  who: FakeSpeaker,
  content: string,
  options: { id?: string; at?: Date } = {},
) => {
  const inbound = fakeInbound(who, content, { mention: false, ...options });
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};
const memory = (projectId: string) =>
  stack.json("GET", `/projects/${projectId}/memory`) as Promise<
    Array<{ type: string; title: string; content: string; createdBy: string; sourceMetadata: any }>
  >;

describe("channel digest", () => {
  it("saves a decision people made among themselves, silently", async () => {
    stack = await startStack({ classifier });
    const projectId = await stack.linkChannel(CHANNEL);

    const t0 = Date.now() - 10 * 60_000;
    const at = new Date(t0 + 60_000);
    await chat(ada, "should we use Postgres or SQLite for the cache?", {
      id: "m1",
      at: new Date(t0),
    });
    await chat(bob, "ok we decided: SQLite, it is one file", { id: "m2", at });
    await chat(ada, "lunch?", { id: "m3", at: new Date(t0 + 120_000) });
    // Nothing answers unmentioned chatter.
    expect(stack.posted).toEqual([]);
    expect(stack.reactions).toEqual([]);

    const runs = await stack.runDigest();

    expect(runs).toEqual([{ projectId, messages: 3, saved: 1 }]);
    expect(stack.posted).toEqual([]);
    expect(stack.digestCalls).toHaveLength(1);
    expect(stack.digestCalls[0]!.messages.map((m) => [m.id, m.sender])).toEqual([
      ["m1", "Ada"],
      ["m2", "Bob"],
      ["m3", "Ada"],
    ]);
    const saved = await memory(projectId);
    expect(saved).toEqual([
      expect.objectContaining({
        type: "decision",
        title: "ok we decided: SQLite, it is one file",
        content: "Bob: ok we decided: SQLite, it is one file",
        createdBy: CHANNEL_DIGEST_AUTHOR,
        // Who said it, when, and a link back, so "why do we use SQLite?" has an answer.
        sourceMetadata: {
          source: "channel_digest",
          channelType: "discord",
          channelId: CHANNEL,
          messages: [
            {
              id: "m2",
              sender: "Bob",
              senderId: "u2",
              sentAt: at.toISOString(),
              url: `https://discord.com/channels/${GUILD}/${CHANNEL}/m2`,
              quote: "ok we decided: SQLite, it is one file",
            },
          ],
        },
      }),
    ]);
    // Digested messages are gone: the next run has nothing to read.
    expect(await stack.runDigest()).toEqual([]);
    expect(stack.digestCalls).toHaveLength(1);
  });

  it("reads ticket threads and mentioned messages too, and skips what memory already has", async () => {
    stack = await startStack({ classifier });
    const projectId = await stack.linkChannel(CHANNEL);

    const ask = fakeInbound(ada, "please add dark mode", { id: "m1" })!;
    await forwardInbound(stack.coordinator, ask, fetch);
    expect(stack.createdThreads).toHaveLength(1);
    await chat({ ...bob, threadId: "discord-thread-1" }, "decision: dark by default", { id: "m2" });

    await stack.runDigest();
    expect(stack.digestCalls[0]!.messages).toEqual([
      expect.objectContaining({ id: "m1", content: "please add dark mode" }),
      expect.objectContaining({ id: "m2", threadId: "discord-thread-1" }),
    ]);
    expect((await memory(projectId))[0]!.sourceMetadata.messages).toEqual([
      expect.objectContaining({
        id: "m2",
        threadId: "discord-thread-1",
        url: `https://discord.com/channels/${GUILD}/discord-thread-1/m2`,
      }),
    ]);

    // Said again later: the digester is shown the saved title and doesn't repeat it.
    await chat(bob, "decision: dark by default", { id: "m3" });
    await stack.runDigest();
    expect(stack.digestCalls[1]!.known).toContain("decision: dark by default");
    expect(await memory(projectId)).toHaveLength(1);
  });

  it("waits until the channel goes quiet, or the oldest message has waited long enough", async () => {
    stack = await startStack({ classifier });
    await stack.linkChannel(CHANNEL);
    await chat(ada, "we decided to ship on Friday");

    expect(await stack.runDigest({ quietMs: 30 * 60_000 })).toEqual([]);
    expect(stack.digestCalls).toHaveLength(0);

    const runs = await stack.runDigest({ quietMs: 30 * 60_000, maxWaitMs: 0 });
    expect(runs.map((r) => r.saved)).toEqual([1]);
  });

  it("keeps the messages when the model fails, and waits before trying that project again", async () => {
    stack = await startStack({ classifier, failDigest: "provider down" });
    const projectId = await stack.linkChannel(CHANNEL);
    await chat(ada, "we decided to ship on Friday");

    expect(await stack.runDigest()).toEqual([
      { projectId, messages: 0, saved: 0, error: "provider down" },
    ]);
    expect(await stack.runDigest()).toEqual([]);
    expect(stack.digestCalls).toHaveLength(1);
    expect(await memory(projectId)).toEqual([]);
    expect(stack.posted).toEqual([]);
  });

  it("drops messages the digest never got to once they pass the retention window", async () => {
    stack = await startStack({ classifier });
    await stack.linkChannel(CHANNEL);
    await chat(ada, "we decided to ship on Friday", { at: new Date(Date.now() - 8 * 86_400_000) });

    expect(await stack.runDigest()).toEqual([]);
    expect(stack.digestCalls).toHaveLength(0);
  });

  it("posts what it saved in the channel when the project says so", async () => {
    stack = await startStack({ classifier });
    const projectId = await stack.linkChannel(CHANNEL);
    const project = await stack.json("PATCH", `/projects/${projectId}`, {
      channelDigestNotify: true,
    });
    expect(project).toMatchObject({ channelDigest: true, channelDigestNotify: true });
    await chat(ada, "we decided to ship on Friday");

    await stack.runDigest();
    expect(await memory(projectId)).toHaveLength(1);
    expect(stack.posted).toEqual([
      {
        target: { channelId: CHANNEL },
        content: digestNotice([{ type: "decision", title: "we decided to ship on Friday" }]),
      },
    ]);
  });

  it("keeps nothing for a project with the digest turned off, and drops what it kept before", async () => {
    stack = await startStack({ classifier });
    const projectId = await stack.linkChannel(CHANNEL);
    await chat(ada, "we decided to ship on Friday");
    await stack.json("PATCH", `/projects/${projectId}`, { channelDigest: false });
    await chat(ada, "we decided to ship on Monday");

    expect(await stack.runDigest()).toEqual([{ projectId, messages: 0, saved: 0 }]);
    expect(await stack.runDigest()).toEqual([]);
    expect(stack.digestCalls).toHaveLength(0);
  });

  it("keeps nothing from a channel no project links", async () => {
    stack = await startStack({ classifier });
    await chat({ ...ada, channelId: "elsewhere" }, "we decided to ship on Monday");

    expect(await stack.runDigest()).toEqual([]);
  });
});
