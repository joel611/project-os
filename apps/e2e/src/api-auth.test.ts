import { emailFor } from "@project-os/auth";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { OPERATOR, SERVICE_TOKEN, type Stack, startStack } from "./stack.ts";

// Who may call what on the Coordinator: the dashboard API needs an allowed operator's session,
// message ingress needs the Channel Adapters' service token, and a few routes stay open.

let stack: Stack;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request") });
});
afterEach(() => stack.stop());

const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  fetch(`${stack.url}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token && { authorization: `Bearer ${init.token}` }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });

const signIn = async (email: string, password: string) => {
  const res = await call("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
  });
  return { status: res.status, token: res.headers.get("set-auth-token") };
};

const inbound = fakeInbound({ channelId: "chan-1", userId: "u1", name: "Ada" }, "hello")!;

describe("dashboard API", () => {
  it("refuses a caller without credentials", async () => {
    const res = await call("/projects");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect((await call("/tickets/t1")).status).toBe(401);
  });

  it("serves the operator once they sign in with their password", async () => {
    const { status, token } = await signIn(OPERATOR.email, OPERATOR.password);
    expect(status).toBe(200);
    const res = await call("/projects", { token: token! });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("gives no session for a wrong password or an unknown email", async () => {
    expect(await signIn(OPERATOR.email, "wrong-password")).toEqual({ status: 401, token: null });
    expect(await signIn("eve@example.com", "anything-at-all")).toEqual({
      status: 401,
      token: null,
    });
  });

  it("refuses a session for a person's channel identity", async () => {
    const ctx = await stack.auth.auth.$context;
    const person = await ctx.internalAdapter.createUser(
      { email: emailFor({ channelType: "discord", id: "u1" }), name: "Ada", emailVerified: false },
      { method: "channel-identity" },
    );
    const session = await ctx.internalAdapter.createSession(person.id);
    const res = await call("/projects", { token: session.token });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("stops honoring a token after sign-out", async () => {
    const { token } = await signIn(OPERATOR.email, OPERATOR.password);
    const out = await call("/api/auth/sign-out", { method: "POST", token: token! });
    expect(out.status).toBe(200);
    expect((await call("/projects", { token: token! })).status).toBe(401);
  });
});

describe("message ingress", () => {
  it("takes /inbound only with the service token", async () => {
    expect((await call("/inbound", { method: "POST", body: inbound })).status).toBe(401);
    const asOperator = await call("/inbound", {
      method: "POST",
      body: inbound,
      token: stack.operatorToken,
    });
    expect(asOperator.status).toBe(403);
    const asService = await call("/inbound", {
      method: "POST",
      body: inbound,
      token: SERVICE_TOKEN,
    });
    expect(asService.status).toBe(200);
  });

  it("refuses /commands and /prompts/answer without the service token", async () => {
    for (const path of ["/commands", "/prompts/answer"]) {
      expect((await call(path, { method: "POST", body: {} })).status).toBe(401);
      expect(
        (await call(path, { method: "POST", body: {}, token: stack.operatorToken })).status,
      ).toBe(403);
    }
  });

  it("is what the Discord adapter reaches with its configured token", async () => {
    await expect(forwardInbound(stack.coordinator, inbound, fetch)).resolves.toBeUndefined();
    await expect(
      forwardInbound({ url: stack.url, token: "not-the-token" }, inbound, fetch),
    ).rejects.toThrow(/401/);
  });
});

describe("MCP", () => {
  const listTools = (token?: string) =>
    call("/mcp", {
      method: "POST",
      ...(token && { token }),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

  it("refuses a caller without a token, or with a dashboard session", async () => {
    expect((await listTools()).status).toBe(401);
    expect((await listTools(stack.operatorToken)).status).toBe(401);
    expect((await listTools(SERVICE_TOKEN)).status).toBe(401);
  });

  it("keeps a sandbox token to its own worker id and tickets", async () => {
    const shared = await stack.registerSharedWorker();
    await stack.linkChannel("chan-1");
    await forwardInbound(stack.coordinator, inbound, fetch);
    const [project] = await stack.json("GET", "/projects");
    const [ticket] = await stack.json("GET", `/projects/${project.id}/tickets`);
    expect(ticket.workerId).toBe(shared.workerId);

    const sandbox = await stack.worker(await stack.sandboxToken("daytona-other"));
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = (await sandbox.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return res.isError ? JSON.parse(res.content[0]!.text)._tag : "ok";
    };
    expect(await tool("ticket_list_assigned", { workerId: "daytona-other" })).toBe("ok");
    expect(await tool("ticket_list_assigned", { workerId: shared.workerId })).toBe(
      "WorkerUnauthorized",
    );
    expect(await tool("ticket_get", { ticketId: ticket.id })).toBe("WorkerUnauthorized");
    expect(await tool("ticket_update_status", { ticketId: ticket.id, status: "completed" })).toBe(
      "WorkerUnauthorized",
    );
  });
});

describe("open routes", () => {
  it("serves health and device registration without credentials", async () => {
    expect((await call("/health")).status).toBe(200);
    const register = await call("/workers/register", {
      method: "POST",
      body: { token: "unknown-code" },
    });
    // Reached the route, not the guard: the code itself is the proof, and this one is unknown.
    expect(await register.json()).toMatchObject({ error: "RegistrationInvalid" });
  });
});
