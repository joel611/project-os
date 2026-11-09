import { Miniflare } from "miniflare";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

// The Cloudflare half of the Discord split, in workerd (Miniflare): the Coordinator's real
// CloudflareLive sends through a service binding to the real gateway Worker, which forwards to a
// Durable Object. Faked: the container behind that Durable Object (needs Docker and a Discord
// login; `alchemy dev` covers it, see docs/deployment.md). Every outbound fetch is refused, so a
// reply that left through the global `fetch` instead of the binding fails the test.

const bundle = async (entry: string) => {
  const built = await Bun.build({
    entrypoints: [new URL(entry, import.meta.url).pathname],
    target: "browser",
    conditions: ["workerd", "worker", "import"],
    format: "esm",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  return built.outputs[0]!.text();
};

let coordinatorScript: string;
let gatewayScript: string;
const instances: Miniflare[] = [];

beforeAll(async () => {
  [coordinatorScript, gatewayScript] = await Promise.all([
    bundle("./discord-gateway/coordinator.ts"),
    bundle("./discord-gateway/gateway.ts"),
  ]);
}, 60_000);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((mf) => mf.dispose().catch(() => undefined)));
});

interface GatewayLog {
  readonly seen: readonly { readonly path: string; readonly body: Record<string, unknown> }[];
  readonly started: number;
}

const boot = async () => {
  const common = { compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"] };
  const mf = new Miniflare({
    workers: [
      {
        ...common,
        name: "coordinator",
        modules: [{ type: "ESModule", path: "coordinator.js", contents: coordinatorScript }],
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        serviceBindings: { DISCORD_GATEWAY: "gateway" },
        outboundService: () =>
          new Response("blocked: the test makes no outbound requests", { status: 502 }),
      },
      {
        ...common,
        name: "gateway",
        modules: [{ type: "ESModule", path: "gateway.js", contents: gatewayScript }],
        durableObjects: { Gateway: "TestGateway" },
      },
    ],
  });
  instances.push(mf);
  const send = async (body: object) =>
    (await (
      await mf.dispatchFetch("http://coordinator/", { method: "POST", body: JSON.stringify(body) })
    ).json()) as
      | { ok: true; created?: { channelId: string; name: string } }
      | { ok: false; message: string };
  const gateway = await mf.getWorker("gateway");
  const log = async () => (await (await gateway.fetch("http://gateway/_log")).json()) as GatewayLog;
  return { send, gateway, log };
};

describe("Discord gateway on Cloudflare", () => {
  it("delivers a Coordinator reply to the gateway through the service binding", async () => {
    const { send, log } = await boot();

    const result = await send({ op: "reply", content: "ticket done" });

    expect(result).toEqual({ ok: true });
    expect((await log()).seen).toEqual([
      {
        path: "/reply",
        body: { channelType: "discord", channelId: "c1", threadId: "t1", content: "ticket done" },
      },
    ]);
  });

  it("creates a channel and returns what the gateway answered", async () => {
    const { send, log } = await boot();

    const result = await send({ op: "createChannel", name: "acme" });

    expect(result).toEqual({ ok: true, created: { channelId: "c-new", name: "acme" } });
    expect((await log()).seen.map((s) => s.path)).toEqual(["/channels"]);
  });

  it("reports a gateway failure to the caller", async () => {
    const { send } = await boot();

    const result = await send({ op: "createChannel", name: "fail" });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("replied 502: discord post failed"),
    });
  });

  it("starts the container when the Cron Trigger fires", async () => {
    const { gateway, log } = await boot();
    expect((await log()).started).toBe(0);

    await gateway.scheduled({ cron: "* * * * *" });

    expect((await log()).started).toBe(1);
  });
});
