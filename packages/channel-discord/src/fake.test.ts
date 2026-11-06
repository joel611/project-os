import { describe, expect, it } from "vite-plus/test";
import { fakeCommand, fakeInbound } from "./fake.ts";

const speaker = { channelId: "c1", userId: "u1", name: "Ada" };

describe("fakeInbound", () => {
  it("builds a channel message", () => {
    const m = fakeInbound(speaker, "hi", { id: "m1", at: new Date("2026-11-04T00:00:00Z") });
    expect(m).toMatchObject({
      channelType: "discord",
      externalId: "m1",
      channelId: "c1",
      sender: { id: "u1", name: "Ada" },
      content: "hi",
      mentionsBot: true,
    });
    expect(m).not.toHaveProperty("threadId");
  });

  it("can speak without mentioning the bot", () => {
    expect(fakeInbound(speaker, "hi", { mention: false })).toMatchObject({
      content: "hi",
      mentionsBot: false,
    });
  });

  it("maps a thread to its parent channel plus threadId", () => {
    expect(fakeInbound({ ...speaker, threadId: "th1" }, "hi")).toMatchObject({
      channelId: "c1",
      threadId: "th1",
    });
  });

  it("returns null for blank content and generates unique ids", () => {
    expect(fakeInbound(speaker, "  ")).toBeNull();
    expect(fakeInbound(speaker, "a")!.externalId).not.toBe(fakeInbound(speaker, "a")!.externalId);
  });
});

describe("fakeCommand", () => {
  it("builds a slash command through the real normalizer", () => {
    expect(fakeCommand(speaker, "project-create", { name: "Acme" }, "i1")).toEqual({
      channelType: "discord",
      command: "project-create",
      externalId: "i1",
      channelId: "c1",
      sender: { id: "u1", name: "Ada" },
      options: { name: "Acme" },
    });
  });

  it("maps a thread, generates ids, and ignores unknown commands", () => {
    const cmd = fakeCommand({ ...speaker, threadId: "th1" }, "project-create", {});
    expect(cmd).toMatchObject({ channelId: "c1", threadId: "th1" });
    expect(cmd!.externalId).toMatch(/^fake-cmd-/);
    expect(fakeCommand(speaker, "other", {})).toBeNull();
  });
});
