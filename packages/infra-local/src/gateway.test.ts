import { describe, expect, it } from "vite-plus/test";
import { Effect, Exit } from "effect";
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
});
