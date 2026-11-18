import { ChannelGateway } from "@project-os/core";
import { makeHttpChannelGateway } from "../../../packages/infra-local/src/gateway.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createReplyApp } from "../../../packages/channel-discord/src/reply.ts";
import { makeLifecycleNotifications } from "../../coordinator/src/lifecycle.ts";

describe("coordinator lifecycle through Discord gateway", () => {
  it("retries a split gateway until ready and posts both events to the admin channel", async () => {
    const posted: Array<{ target: unknown; content: string }> = [];
    const adapter = createReplyApp(async (target, content) => {
      posted.push({ target, content });
    }).listen(0);
    let available = false;
    const gateway = makeHttpChannelGateway({
      adapterUrls: { discord: `http://localhost:${adapter.server!.port}` },
      fetch: (url, init) => (available ? fetch(url, init) : Promise.reject(new Error("not ready"))),
    });
    try {
      const lifecycle = makeLifecycleNotifications({
        channelId: "admin-chan",
        retryStartup: true,
        timeoutMs: 2000,
        run: (effect) => Effect.runPromise(Effect.provideService(effect, ChannelGateway, gateway)),
      });
      setTimeout(() => {
        available = true;
      }, 50);
      await lifecycle.started;
      await lifecycle.stop();
      expect(posted).toEqual([
        { target: { channelId: "admin-chan" }, content: "Coordinator started." },
        { target: { channelId: "admin-chan" }, content: "Coordinator stopped." },
      ]);
    } finally {
      adapter.stop();
    }
  });
});
