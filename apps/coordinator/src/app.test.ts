import { Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import type { McpRuntime } from "./mcp/server.ts";

describe("coordinator app", () => {
  it("serves GET /health", async () => {
    const res = await createApp().handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "coordinator" });
  });

  it("mounts /mcp only when given an MCP runtime", async () => {
    const req = () => new Request("http://localhost/mcp", { method: "DELETE" });
    expect((await createApp().handle(req())).status).toBe(404);
    const runtime = ManagedRuntime.make(Layer.empty) as McpRuntime;
    const res = await createApp({}, { mcp: runtime }).handle(req());
    expect(res.status).not.toBe(404);
    await runtime.dispose();
  });
});
