import { describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "./fake.ts";

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
    });
    expect(m).not.toHaveProperty("threadId");
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
