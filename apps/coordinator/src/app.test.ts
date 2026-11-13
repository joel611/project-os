import { makeTestLayer } from "@project-os/testing";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { type Access, type Caller, ROUTE_POLICY } from "./access.ts";
import { type AppDeps, createApp, parseOrigins } from "./app.ts";
import type { McpRuntime } from "./mcp/server.ts";

const web = "https://dash.example.com";
const ADA = { channelType: "discord", id: "u-ada", name: "Ada" } as const;

const access: Access = {
  caller: async (request): Promise<Caller> => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token === "svc") return { kind: "service" };
    if (token === "op") return { kind: "user", userId: "u-op", name: "Op" };
    if (token === "ada") return { kind: "member", userId: "u-ada", person: ADA };
    if (token === "eve") return { kind: "outsider" };
    return { kind: "anonymous" };
  },
  personOf: async (caller) => (caller.kind === "member" ? caller.person : undefined),
};

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()));
});

const fullApp = (extra: Partial<AppDeps> = {}) => {
  const runtime = ManagedRuntime.make(makeTestLayer().layer);
  disposers.push(() => runtime.dispose());
  return createApp(
    {},
    {
      access,
      http: { run: (effect) => runtime.runPromise(effect) },
      mcp: runtime as unknown as McpRuntime,
      auth: { handler: async () => Response.json({ ok: true }) },
      connect: { startLink: async () => null },
      ...extra,
    },
  );
};

const call = (
  app: { handle: (r: Request) => Promise<Response> },
  path: string,
  init: { method?: string; token?: string; body?: unknown; origin?: string } = {},
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.token && { authorization: `Bearer ${init.token}` }),
        ...(init.origin && { origin: init.origin }),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    }),
  );

describe("coordinator app", () => {
  it("serves GET /health to anyone", async () => {
    const res = await createApp({}, { access }).handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "coordinator" });
  });

  describe("access", () => {
    it("names a policy for every route it mounts", () => {
      const routes = fullApp().routes.map((r: { method: string; path: string }) => {
        return `${r.method} ${r.path}`;
      });
      expect(routes.length).toBeGreaterThan(20);
      expect(routes.filter((route: string) => !(route in ROUTE_POLICY))).toEqual([]);
    });

    it("lets a member read only who they are, their tickets and a ticket", async () => {
      const app = fullApp();
      expect((await call(app, "/projects", { token: "ada" })).status).toBe(403);
      expect((await call(app, "/workers", { token: "ada" })).status).toBe(403);
      expect((await call(app, "/activity", { token: "ada" })).status).toBe(403);
      const me = await call(app, "/me", { token: "ada" });
      expect(await me.json()).toEqual({
        role: "member",
        name: "Ada",
        person: { channelType: "discord", id: "u-ada", name: "Ada" },
      });
      const mine = await call(app, "/me/tickets", { token: "ada" });
      expect(await mine.json()).toEqual({ tickets: [], projects: [] });
      // Someone else's ticket and a missing one look the same.
      expect((await call(app, "/tickets/nope", { token: "ada" })).status).toBe(404);
      expect((await call(app, "/me", { token: "eve" })).status).toBe(403);
      expect((await call(app, "/me", {})).status).toBe(401);
      const op = await call(app, "/me", { token: "op" });
      expect(await op.json()).toEqual({ role: "operator", name: "Op", person: null });
    });

    it("names a member by id when the channel gave no name, and an operator's linked person", async () => {
      const app = fullApp({
        access: {
          caller: async (request) =>
            request.headers.get("authorization") === "Bearer op"
              ? { kind: "user", userId: "u-op", name: "Op" }
              : { kind: "member", userId: "u-x", person: { channelType: "discord", id: "42" } },
          personOf: async (caller) =>
            caller.kind === "member" ? caller.person : { channelType: "discord", id: "7" },
        },
      });
      expect(await (await call(app, "/me", { token: "x" })).json()).toEqual({
        role: "member",
        name: "42",
        person: { channelType: "discord", id: "42", name: null },
      });
      expect(await (await call(app, "/me", { token: "op" })).json()).toMatchObject({
        role: "operator",
        name: "Op",
        person: { id: "7", name: null },
      });
    });

    it("lets only an allowed operator read the dashboard API", async () => {
      const app = fullApp();
      expect((await call(app, "/projects")).status).toBe(401);
      expect(await (await call(app, "/projects")).json()).toEqual({ error: "Unauthorized" });
      expect((await call(app, "/projects", { token: "nope" })).status).toBe(401);
      expect((await call(app, "/projects", { token: "eve" })).status).toBe(403);
      expect((await call(app, "/projects", { token: "svc" })).status).toBe(403);
      const ok = await call(app, "/projects", { token: "op" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual([]);
    });

    it("lets only an allowed operator remove a project source", async () => {
      const app = fullApp();
      const path = "/projects/p1/sources/s1";
      expect((await call(app, path, { method: "DELETE" })).status).toBe(401);
      expect((await call(app, path, { method: "DELETE", token: "eve" })).status).toBe(403);
      expect((await call(app, path, { method: "DELETE", token: "svc" })).status).toBe(403);
      expect((await call(app, path, { method: "DELETE", token: "op" })).status).toBe(404);
    });

    it("takes messages, commands and prompt answers only from a Channel Adapter", async () => {
      const app = fullApp();
      for (const path of ["/inbound", "/commands", "/prompts/answer"]) {
        expect((await call(app, path, { method: "POST", body: {} })).status).toBe(401);
        expect((await call(app, path, { method: "POST", body: {}, token: "op" })).status).toBe(403);
        const svc = await call(app, path, { method: "POST", body: {}, token: "svc" });
        expect(svc.status).toBe(400);
      }
    });

    it("says a connect link is used up when starting the provider flow fails", async () => {
      const app = fullApp({
        connect: {
          startLink: async () => {
            throw new Error("provider down");
          },
        },
      });
      const res = await call(app, "/connect/abc", { method: "POST" });
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Run /connect again");
    });

    it("keeps sign-in, connect links and device registration open", async () => {
      const app = fullApp();
      expect(
        (await call(app, "/api/auth/sign-in/email", { method: "POST", body: {} })).status,
      ).toBe(200);
      expect((await call(app, "/connect/abc")).status).toBe(200);
      expect((await call(app, "/connect/abc", { method: "POST" })).status).toBe(410);
      const register = await call(app, "/workers/register", { method: "POST", body: {} });
      expect(register.status).toBe(400);
    });
  });

  describe("CORS", () => {
    it("sends no CORS headers unless origins are configured", async () => {
      for (const corsOrigins of [undefined, []]) {
        const app = createApp({}, { access, ...(corsOrigins && { corsOrigins }) });
        const res = await call(app, "/health", { origin: web });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("allows a listed origin and not another", async () => {
      const app = createApp({}, { access, corsOrigins: [web] });
      const ok = await call(app, "/health", { origin: web });
      expect(ok.headers.get("access-control-allow-origin")).toBe(web);
      expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
      const other = await call(app, "/health", { origin: "https://evil.example" });
      expect(other.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
    });

    it("answers a preflight for authorized JSON writes", async () => {
      const app = fullApp({ corsOrigins: [web] });
      const res = await app.handle(
        new Request("http://localhost/projects/p1", {
          method: "OPTIONS",
          headers: {
            origin: web,
            "access-control-request-method": "PATCH",
            "access-control-request-headers": "authorization, content-type",
          },
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(web);
      expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
      expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    });

    it("lets the dashboard read a 401 and the sign-in token header", async () => {
      const app = fullApp({ corsOrigins: [web] });
      const denied = await call(app, "/projects", { origin: web });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("access-control-allow-origin")).toBe(web);
      const signIn = await call(app, "/api/auth/sign-in/email", {
        method: "POST",
        body: {},
        origin: web,
      });
      expect(signIn.headers.get("access-control-expose-headers")).toContain("set-auth-token");
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
    expect((await createApp({}, { access }).handle(req())).status).toBe(404);
    const runtime = ManagedRuntime.make(Layer.empty) as McpRuntime;
    const res = await createApp({}, { access, mcp: runtime }).handle(req());
    expect(res.status).not.toBe(404);
    await runtime.dispose();
  });
});
