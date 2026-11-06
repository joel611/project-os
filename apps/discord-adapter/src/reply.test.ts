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

const create = (app: ReturnType<typeof createReplyApp>, body: unknown) =>
  app.handle(
    new Request("http://localhost/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("channels endpoint", () => {
  it("creates a channel and returns its id and final name", async () => {
    const names: string[] = [];
    const app = createReplyApp(
      async () => {},
      async (name) => {
        names.push(name);
        return { channelId: "new-1", name: "acme-site" };
      },
    );
    const res = await create(app, { channelType: "discord", name: "Acme Site" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelId: "new-1", name: "acme-site" });
    expect(names).toEqual(["Acme Site"]);
  });

  it("rejects invalid bodies and non-discord channel types", async () => {
    const app = createReplyApp(
      async () => {},
      async () => ({ channelId: "x", name: "x" }),
    );
    expect((await create(app, { nope: 1 })).status).toBe(400);
    expect((await create(app, { channelType: "email", name: "x" })).status).toBe(400);
  });

  it("answers 501 when the adapter can't create channels", async () => {
    const app = createReplyApp(async () => {});
    expect((await create(app, { channelType: "discord", name: "x" })).status).toBe(501);
  });

  it("returns 502 with Discord's error, e.g. a missing Manage Channels permission", async () => {
    const app = createReplyApp(
      async () => {},
      async () => {
        throw new Error("Missing Permissions");
      },
    );
    const res = await create(app, { channelType: "discord", name: "x" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Missing Permissions" });
  });

  it("returns 502 with a generic message for non-Error failures", async () => {
    const app = createReplyApp(
      async () => {},
      async () => {
        throw "x";
      },
    );
    const res = await create(app, { channelType: "discord", name: "x" });
    expect(await res.json()).toEqual({ error: "discord channel create failed" });
  });
});

const thread = (app: ReturnType<typeof createReplyApp>, body: unknown) =>
  app.handle(
    new Request("http://localhost/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("threads endpoint", () => {
  const request = { channelType: "discord", channelId: "c1", messageId: "m1", name: "Fix it" };
  const noChannel = async () => ({ channelId: "x", name: "x" });

  it("opens a thread on the message and returns its id", async () => {
    const calls: unknown[] = [];
    const app = createReplyApp(
      async () => {},
      noChannel,
      async (input) => {
        calls.push(input);
        return { threadId: "th-1" };
      },
    );
    const res = await thread(app, request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadId: "th-1" });
    expect(calls).toEqual([{ channelId: "c1", messageId: "m1", name: "Fix it" }]);
  });

  it("rejects invalid bodies and non-discord channel types", async () => {
    const app = createReplyApp(
      async () => {},
      noChannel,
      async () => ({ threadId: "x" }),
    );
    expect((await thread(app, { nope: 1 })).status).toBe(400);
    expect((await thread(app, { ...request, channelType: "email" })).status).toBe(400);
  });

  it("answers 501 when the adapter can't open threads", async () => {
    const app = createReplyApp(async () => {});
    expect((await thread(app, request)).status).toBe(501);
  });

  it("returns 502 with Discord's error, or a generic one for non-Error failures", async () => {
    const failing = (err: unknown) =>
      createReplyApp(
        async () => {},
        noChannel,
        async () => {
          throw err;
        },
      );
    const res = await thread(failing(new Error("Missing Permissions")), request);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Missing Permissions" });
    const generic = await thread(failing("x"), request);
    expect(await generic.json()).toEqual({ error: "discord thread create failed" });
  });
});

const reactTo = (app: ReturnType<typeof createReplyApp>, body: unknown) =>
  app.handle(
    new Request("http://localhost/reactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("reactions endpoint", () => {
  const instruction = {
    channelType: "discord",
    channelId: "c1",
    threadId: "t1",
    messageId: "m1",
    emoji: "👀",
  };

  it("reacts to the message", async () => {
    const calls: unknown[] = [];
    const app = createReplyApp(
      async () => {},
      undefined,
      undefined,
      async (input) => void calls.push(input),
    );
    const res = await reactTo(app, instruction);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ channelId: "c1", threadId: "t1", messageId: "m1", emoji: "👀" }]);
  });

  it("answers 501 without a react function, 400 on bad bodies", async () => {
    const app = createReplyApp(async () => {});
    expect((await reactTo(app, instruction)).status).toBe(501);
    expect((await reactTo(app, { channelType: "discord", channelId: "c1" })).status).toBe(400);
  });

  it("returns 502 when Discord refuses", async () => {
    const app = createReplyApp(
      async () => {},
      undefined,
      undefined,
      async () => {
        throw new Error("Missing Permissions");
      },
    );
    const res = await reactTo(app, instruction);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Missing Permissions" });
  });
});
