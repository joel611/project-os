import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect, Exit } from "effect";
import { makeHttpChannelGateway } from "./gateway.ts";

describe("HTTP ChannelGateway", () => {
  const reply = { channelType: "discord", channelId: "c1", threadId: "t1", content: "hi" } as const;

  it("POSTs the reply to the adapter's /reply endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const gateway = makeHttpChannelGateway({
      adapterUrls: { discord: "http://discord:3001/" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("ok");
      },
    });
    await Effect.runPromise(gateway.send(reply));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://discord:3001/reply");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(reply);
  });

  it("dies when no adapter is configured for the channel type", async () => {
    const gateway = makeHttpChannelGateway({ adapterUrls: {}, fetch: async () => new Response() });
    expect(Exit.isFailure(await Effect.runPromiseExit(gateway.send(reply)))).toBe(true);
  });

  it("dies on a non-2xx response", async () => {
    const gateway = makeHttpChannelGateway({
      adapterUrls: { discord: "http://d" },
      fetch: async () => new Response("bad", { status: 500 }),
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(gateway.send(reply)))).toBe(true);
  });

  describe("createChannel", () => {
    const request = { channelType: "discord", name: "Acme" } as const;

    it("POSTs to the adapter's /channels endpoint and returns the created channel", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      const gateway = makeHttpChannelGateway({
        adapterUrls: { discord: "http://discord:3001/" },
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({ channelId: "c9", name: "acme" });
        },
      });
      expect(await Effect.runPromise(gateway.createChannel(request))).toEqual({
        channelId: "c9",
        name: "acme",
      });
      expect(calls).toEqual([{ url: "http://discord:3001/channels", body: request }]);
    });

    const failure = async (gateway: ReturnType<typeof makeHttpChannelGateway>) => {
      const exit = await Effect.runPromiseExit(gateway.createChannel(request));
      if (!Exit.isFailure(exit)) throw new Error("expected failure");
      const error = Cause.findErrorOption(exit.cause);
      if (error._tag === "None") throw new Error("expected a typed failure, got a defect");
      return error.value;
    };

    it("fails with ChannelCreateFailed carrying the adapter's error", async () => {
      const error = await failure(
        makeHttpChannelGateway({
          adapterUrls: { discord: "http://d" },
          fetch: async () => Response.json({ error: "Missing Permissions" }, { status: 502 }),
        }),
      );
      expect(error).toMatchObject({ _tag: "ChannelCreateFailed", channelType: "discord" });
      expect(error.message).toContain("Missing Permissions");
    });

    it("fails without detail on a non-JSON error, and on a non-Error rejection", async () => {
      expect(
        await failure(
          makeHttpChannelGateway({
            adapterUrls: { discord: "http://d" },
            fetch: async () => new Response("bad gateway", { status: 502 }),
          }),
        ),
      ).toMatchObject({ message: "Adapter discord replied 502" });
      expect(
        await failure(
          makeHttpChannelGateway({
            adapterUrls: { discord: "http://d" },
            fetch: () => Promise.reject("offline"),
          }),
        ),
      ).toMatchObject({ message: "offline" });
    });

    it("fails when no adapter is configured or the response is malformed", async () => {
      expect(
        await failure(
          makeHttpChannelGateway({ adapterUrls: {}, fetch: async () => new Response() }),
        ),
      ).toMatchObject({ _tag: "ChannelCreateFailed" });
      expect(
        await failure(
          makeHttpChannelGateway({
            adapterUrls: { discord: "http://d" },
            fetch: async () => Response.json({ nope: 1 }),
          }),
        ),
      ).toMatchObject({ message: "Adapter returned an invalid channel" });
    });
  });

  describe("createThread", () => {
    const request = {
      channelType: "discord",
      channelId: "c1",
      messageId: "m1",
      name: "Fix it",
    } as const;

    it("POSTs to the adapter's /threads endpoint and returns the thread", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      const gateway = makeHttpChannelGateway({
        adapterUrls: { discord: "http://discord:3001/" },
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({ threadId: "th9" });
        },
      });
      expect(await Effect.runPromise(gateway.createThread(request))).toEqual({ threadId: "th9" });
      expect(calls).toEqual([{ url: "http://discord:3001/threads", body: request }]);
    });

    it("fails with ThreadCreateFailed on an adapter error or a malformed response", async () => {
      const failure = async (fetch: () => Promise<Response>) => {
        const gateway = makeHttpChannelGateway({ adapterUrls: { discord: "http://d" }, fetch });
        const exit = await Effect.runPromiseExit(gateway.createThread(request));
        if (!Exit.isFailure(exit)) throw new Error("expected failure");
        const error = Cause.findErrorOption(exit.cause);
        if (error._tag === "None") throw new Error("expected a typed failure, got a defect");
        return error.value;
      };
      expect(
        await failure(async () => Response.json({ error: "Missing Permissions" }, { status: 502 })),
      ).toMatchObject({ _tag: "ThreadCreateFailed", channelType: "discord" });
      expect(await failure(async () => Response.json({ nope: 1 }))).toMatchObject({
        message: "Adapter returned an invalid thread",
      });
    });
  });

  describe("ask", () => {
    const request = {
      channelType: "discord",
      channelId: "c1",
      promptId: "p1",
      kind: "approval",
      content: "Ship?",
      options: ["Approve", "Deny"],
    } as const;

    it("POSTs to the adapter's /prompts endpoint and returns the message id", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      const gateway = makeHttpChannelGateway({
        adapterUrls: { discord: "http://discord:3001" },
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({ messageId: "m7" });
        },
      });
      expect(await Effect.runPromise(gateway.ask(request))).toEqual({ messageId: "m7" });
      expect(calls).toEqual([{ url: "http://discord:3001/prompts", body: request }]);
    });

    it("fails with PromptSendFailed when the adapter refuses", async () => {
      const gateway = makeHttpChannelGateway({
        adapterUrls: { discord: "http://d" },
        fetch: async () => Response.json({ error: "Missing Access" }, { status: 502 }),
      });
      const error = await Effect.runPromise(Effect.flip(gateway.ask(request)));
      expect(error).toMatchObject({ _tag: "PromptSendFailed", channelType: "discord" });
      expect(error.message).toContain("Missing Access");
    });
  });
});
