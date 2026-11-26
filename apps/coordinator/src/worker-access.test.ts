import {
  issueSandboxToken,
  issueWorkerRegistration,
  redeemWorkerRegistration,
} from "@project-os/core";
import { makeTestLayer } from "@project-os/testing";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type Access, ROUTE_POLICY } from "./access.ts";
import { createApp } from "./app.ts";
import type { McpRuntime } from "./mcp/server.ts";

// The dashboard's idea of a caller must not matter on a `worker` route: an admin gets no further.
const access: Access = {
  caller: async () => ({ kind: "user", userId: "u-op", name: "Op", role: "admin" }),
  personOf: async () => undefined,
};

const WITH_MESSAGE = { error: "Unauthorized", message: "Send your MCP token as a Bearer token." };

/** Every `worker` route, as a request to it, with the 401 body deployed Workers get. */
const WORKER_ROUTES: Record<string, { method: string; path: string; body: object }> = {
  "ALL /mcp": { method: "POST", path: "/mcp", body: { error: "Unauthorized" } },
  "ALL /egress/:service/*": { method: "GET", path: "/egress/github/user", body: WITH_MESSAGE },
  "GET /tickets/:id/skills": { method: "GET", path: "/tickets/t1/skills", body: WITH_MESSAGE },
  "GET /tickets/:id/task-type": {
    method: "GET",
    path: "/tickets/t1/task-type",
    body: WITH_MESSAGE,
  },
  "POST /tickets/:id/runs": { method: "POST", path: "/tickets/t1/runs", body: WITH_MESSAGE },
};

let runtime: ManagedRuntime.ManagedRuntime<any, never>;
beforeEach(() => {
  runtime = ManagedRuntime.make(makeTestLayer().layer);
});
afterEach(() => runtime.dispose());

const app = (deps: { credentialProxy?: boolean; fetch?: typeof fetch } = {}) =>
  createApp(
    {},
    {
      access,
      mcp: runtime as unknown as McpRuntime,
      ...(deps.credentialProxy !== false && {
        credentialProxy: { ...(deps.fetch && { fetch: deps.fetch }) },
      }),
    },
  );

const request = (method: string, path: string, authorization?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(authorization !== undefined && { authorization }),
      ...(method === "POST" && { "content-type": "application/json" }),
    },
    ...(method === "POST" && { body: "{}" }),
  });

describe("Worker access", () => {
  it("is tested for every route with the worker policy", () => {
    const listed = Object.keys(ROUTE_POLICY).filter((key) => ROUTE_POLICY[key] === "worker");
    expect(Object.keys(WORKER_ROUTES).sort()).toEqual(listed.sort());
  });

  it.each(Object.values(WORKER_ROUTES))(
    "refuses $method $path without a valid Worker",
    async ({ method, path, body }) => {
      const upstream = vi.fn<typeof fetch>();
      const coordinator = app({ fetch: upstream });
      const expired = await runtime.runPromise(issueSandboxToken("daytona-t1", -1));
      const live = await runtime.runPromise(issueSandboxToken("daytona-t1", 600));
      for (const authorization of [
        undefined,
        "",
        "Bearer ",
        "Bearer nope",
        `Basic ${live}`,
        `Bearer ${expired}`,
      ]) {
        const res = await coordinator.handle(request(method, path, authorization));
        expect(res.status).toBe(401);
        expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
        expect(await res.json()).toEqual(body);
      }
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("never runs a worker route whose handler doesn't ask who is calling", async () => {
    const handler = vi.fn(() => "ran");
    // The credential proxy is off, so its path is free for a bare handler.
    const coordinator = app({ credentialProxy: false }).all("/egress/:service/*", handler);
    for (const authorization of [undefined, "Bearer nope"]) {
      const res = await coordinator.handle(request("GET", "/egress/github/user", authorization));
      expect(res.status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
    const token = await runtime.runPromise(issueSandboxToken("daytona-t1", 600));
    const res = await coordinator.handle(request("GET", "/egress/github/user", `Bearer ${token}`));
    expect(await res.text()).toBe("ran");
  });

  it("refuses everyone when there is nothing to check credentials against", async () => {
    const handler = vi.fn(() => "ran");
    const res = await createApp({}, { access })
      .all("/mcp", handler)
      .handle(request("GET", "/mcp", "Bearer nope"));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits a sandbox session's token and a registered device's secret", async () => {
    const coordinator = app();
    const session = await runtime.runPromise(issueSandboxToken("daytona-t1", 600));
    const device = await runtime.runPromise(
      Effect.gen(function* () {
        const { token } = yield* issueWorkerRegistration({ channelType: "discord", id: "u-ada" });
        return yield* redeemWorkerRegistration({ token, hostname: "mac" });
      }),
    );
    for (const token of [session, device.secret]) {
      const res = await coordinator.handle(
        request("GET", "/tickets/t1/task-type", `Bearer ${token}`),
      );
      // Past admission: core answers that there is no such ticket.
      expect(res.status).toBe(404);
    }
  });
});
