import { describe, expect, it } from "vite-plus/test";
import { createReplyApp } from "./reply.ts";

const post = (app: ReturnType<typeof createReplyApp>, body: unknown) =>
  app.handle(
    new Request("http://localhost/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("reply endpoint", () => {
  it("posts to the channel", async () => {
    const calls: unknown[] = [];
    const app = createReplyApp(async (target, content) => void calls.push([target, content]));
    const res = await post(app, { channelType: "discord", channelId: "c1", content: "hi" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([[{ channelId: "c1" }, "hi"]]);
  });

  it("posts to the thread when threadId is given", async () => {
    const calls: unknown[] = [];
    const app = createReplyApp(async (target, content) => void calls.push([target, content]));
    await post(app, { channelType: "discord", channelId: "c1", threadId: "t1", content: "hi" });
    expect(calls).toEqual([[{ channelId: "c1", threadId: "t1" }, "hi"]]);
  });

  it("rejects invalid bodies and non-discord channel types", async () => {
    const app = createReplyApp(async () => {});
    expect((await post(app, { nope: 1 })).status).toBe(400);
    expect(
      (await post(app, { channelType: "email", channelId: "a@b.c", content: "x" })).status,
    ).toBe(400);
  });

  it("returns 502 when Discord posting fails", async () => {
    const app = createReplyApp(async () => {
      throw new Error("boom");
    });
    const res = await post(app, { channelType: "discord", channelId: "c1", content: "hi" });
    expect(res.status).toBe(502);
  });

  it("returns 502 with a generic message for non-Error failures", async () => {
    const app = createReplyApp(async () => {
      throw "x";
    });
    const res = await post(app, { channelType: "discord", channelId: "c1", content: "hi" });
    expect(await res.json()).toEqual({ error: "discord post failed" });
  });
});
