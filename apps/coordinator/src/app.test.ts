import { Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createApp, parseOrigins } from "./app.ts";
import type { McpRuntime } from "./mcp/server.ts";

describe("coordinator app", () => {
  it("serves GET /health", async () => {
    const res = await createApp().handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "coordinator" });
  });

  describe("CORS", () => {
    const web = "https://dash.example.com";
    const call = (app: ReturnType<typeof createApp>, init: RequestInit = {}) =>
      app.handle(new Request("http://localhost/health", init));

    it("sends no CORS headers unless origins are configured", async () => {
      for (const deps of [{}, { corsOrigins: [] }]) {
        const res = await call(createApp({}, deps), { headers: { origin: web } });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("allows a listed origin and not another", async () => {
      const app = createApp({}, { corsOrigins: [web] });
      const ok = await call(app, { headers: { origin: web } });
      expect(ok.headers.get("access-control-allow-origin")).toBe(web);
      expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
      const other = await call(app, { headers: { origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
    });

    it("answers a preflight for JSON writes", async () => {
      const res = await call(createApp({}, { corsOrigins: [web] }), {
        method: "OPTIONS",
        headers: {
          origin: web,
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "content-type",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(web);
      expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
      expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
    });

    it("parses WEB_ORIGIN", () => {
      expect(parseOrigins(undefined)).toEqual([]);
      expect(parseOrigins(" https://a.dev/ , https://b.dev ,,")).toEqual([
        "https://a.dev",
        "https://b.dev",
      ]);
    });
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
