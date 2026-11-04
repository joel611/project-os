import { Schema } from "effect";
import { InboundMessage } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { normalizeMessage, type DiscordMessageLike } from "./normalize.ts";

const base: DiscordMessageLike = {
  id: "m1",
  content: "hello",
  createdAt: new Date("2026-11-04T04:00:00.000Z"),
  author: { id: "u1", username: "joel", bot: false },
  member: { displayName: "Joel C" },
  channelId: "c1",
  channel: { isThread: () => false },
};

describe("normalizeMessage", () => {
  it("normalizes a channel message to the inbound contract", () => {
    const out = normalizeMessage(base);
    expect(out).toMatchObject({
      channelType: "discord",
      externalId: "m1",
      channelId: "c1",
      sender: { id: "u1", name: "Joel C" },
      content: "hello",
      receivedAt: "2026-11-04T04:00:00.000Z",
    });
    expect(out).not.toHaveProperty("threadId");
    expect(() => Schema.decodeUnknownSync(InboundMessage)(out)).not.toThrow();
  });

  it("uses parent channel + thread id for thread messages", () => {
    const out = normalizeMessage({
      ...base,
      channelId: "t9",
      channel: { isThread: () => true, parentId: "c1" },
    });
    expect(out).toMatchObject({ channelId: "c1", threadId: "t9" });
  });

  it("falls back to the thread id as channel when parent is unknown", () => {
    const out = normalizeMessage({
      ...base,
      channelId: "t9",
      channel: { isThread: () => true, parentId: null },
    });
    expect(out).toMatchObject({ channelId: "t9", threadId: "t9" });
  });

  it("falls back to username when there is no member", () => {
    const out = normalizeMessage({ ...base, member: null });
    expect(out?.sender.name).toBe("joel");
  });

  it("ignores bot messages", () => {
    expect(normalizeMessage({ ...base, author: { ...base.author, bot: true } })).toBeNull();
  });

  it("ignores empty messages", () => {
    expect(normalizeMessage({ ...base, content: "  " })).toBeNull();
  });
});
