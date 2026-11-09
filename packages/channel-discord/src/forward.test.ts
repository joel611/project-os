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
  it("POSTs JSON to <coordinator>/inbound with the service token", async () => {
    let seen: Request | undefined;
    const fetcher = async (r: Request) => ((seen = r), new Response("{}", { status: 200 }));
    await forwardInbound({ url: "http://coord:8080/", token: "svc-token" }, msg, fetcher);
    expect(seen?.url).toBe("http://coord:8080/inbound");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("authorization")).toBe("Bearer svc-token");
    expect(await seen?.json()).toEqual(msg);
  });

  it("throws on non-2xx", async () => {
    const fetcher = async () => new Response("no", { status: 500 });
    await expect(forwardInbound({ url: "http://c", token: "t" }, msg, fetcher)).rejects.toThrow(
      /500/,
    );
  });
});
