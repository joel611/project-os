import { describe, expect, it } from "vite-plus/test";
import { forwardInbound } from "./forward.ts";

const msg = {
  channelType: "discord",
  externalId: "m1",
  channelId: "c1",
  sender: { id: "u1" },
  content: "hi",
  raw: {},
  receivedAt: "2026-11-04T04:00:00.000Z",
} as const;

describe("forwardInbound", () => {
  it("POSTs JSON to <coordinator>/inbound", async () => {
    let seen: Request | undefined;
    const fetcher = async (r: Request) => ((seen = r), new Response("{}", { status: 200 }));
    await forwardInbound("http://coord:8080/", msg, fetcher);
    expect(seen?.url).toBe("http://coord:8080/inbound");
    expect(seen?.method).toBe("POST");
    expect(await seen?.json()).toEqual(msg);
  });

  it("throws on non-2xx", async () => {
    const fetcher = async () => new Response("no", { status: 500 });
    await expect(forwardInbound("http://c", msg, fetcher)).rejects.toThrow(/500/);
  });
});
