import { afterEach, describe, expect, it } from "vite-plus/test";
import { classifierReturning } from "@project-os/testing";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

/**
 * Dashboard roles end to end: a new Google sign-in is a member, an admin promotes them from
 * the Members page, and the permissions follow the role on every route.
 */
const ADA = "ada@example.com";
let stack: Stack;
afterEach(() => stack.stop());

const signIn = async () => {
  const landed = new URL((await browse(`${stack.url}/sign-in/google`)).url);
  const verified = await fetch(`${stack.url}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: landed.searchParams.get("ott")! }),
  });
  return verified.headers.get("set-auth-token")!;
};

const call = async (token: string, path: string, init?: { method: string; json: unknown }) => {
  const res = await fetch(`${stack.url}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init && { "content-type": "application/json" }),
    },
    ...(init && { body: JSON.stringify(init.json) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

describe("dashboard roles", () => {
  it("starts a new sign-in as a member, and lets an admin promote and demote them", async () => {
    stack = await startStack({
      classifier: classifierReturning("new_request"),
      connections: true,
      allowedEmails: [ADA],
    });
    const ada = await signIn();
    const admin = stack.operatorToken;

    // Ada is a member: her own tickets only, and none of the operator routes.
    expect((await call(ada, "/me")).body).toMatchObject({
      role: "member",
      permissions: { ticket: ["read-own"] },
    });
    for (const path of ["/projects", "/members", "/audit", "/workers", "/shared-accounts"]) {
      expect((await call(ada, path)).status, path).toBe(403);
    }

    // The admin finds her on the Members page and promotes her.
    const members = (await call(admin, "/members")).body as Array<{
      key: string;
      email: string;
      role: string;
    }>;
    const row = members.find((m) => m.email === ADA)!;
    expect(row.role).toBe("member");
    expect(
      (await call(admin, `/members/${row.key}/role`, { method: "POST", json: { role: "admin" } }))
        .body,
    ).toEqual({ role: "admin" });
    expect((await call(ada, "/projects")).status).toBe(200);
    expect((await call(ada, "/me")).body.role).toBe("admin");

    // A member can't change roles; an unknown role is refused; unknown users 404.
    expect(
      (await call(admin, `/members/${row.key}/role`, { method: "POST", json: { role: "root" } }))
        .status,
    ).toBe(400);
    expect(
      (await call(admin, "/members/nobody/role", { method: "POST", json: { role: "admin" } }))
        .status,
    ).toBe(404);
    await call(admin, `/members/${row.key}/role`, { method: "POST", json: { role: "member" } });
    expect(
      (await call(ada, `/members/${row.key}/role`, { method: "POST", json: { role: "admin" } }))
        .status,
    ).toBe(403);
  });

  it("never lets the last admin be demoted", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    const admin = stack.operatorToken;
    const me = (await call(admin, "/members")).body[0] as { key: string };
    expect(
      (await call(admin, `/members/${me.key}/role`, { method: "POST", json: { role: "member" } }))
        .status,
    ).toBe(409);
    expect((await call(admin, "/me")).body.role).toBe("admin");
  });
});
