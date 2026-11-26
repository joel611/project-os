import { describe, expect, it } from "vite-plus/test";
import type { SessionUser } from "@project-os/auth";
import { authorize, makeAccess, policyFor, roleOf } from "./access.ts";

const sessions: Record<string, SessionUser> = {
  "ops-session": { userId: "u-ops", email: "Ops@Example.com", name: "Ops", role: "admin" },
  "channel-session": {
    userId: "u-ch",
    email: "discord-1@people.project-os.invalid",
    name: "1",
    role: "member",
  },
  "member-session": {
    userId: "u-m",
    email: "discord-2@people.project-os.invalid",
    name: "Ada",
    role: "member",
  },
};

const ADA = { channelType: "discord", id: "2", name: "Ada" } as const;

const access = makeAccess({
  serviceToken: "the-service-token",
  auth: {
    sessionUser: async (token) => sessions[token],
    isAllowed: (email) => email.toLowerCase() === "ops@example.com",
    // Only u-m still has Google linked.
    memberPerson: async (user) => (user.userId === "u-m" ? ADA : undefined),
    linkedPerson: async (userId) => (userId === "u-ops" ? ADA : undefined),
  },
});

const caller = (authorization?: string) =>
  access.caller(
    new Request("http://localhost/x", {
      headers: authorization === undefined ? {} : { authorization },
    }),
  );

describe("makeAccess", () => {
  it("knows the service by its token", async () => {
    expect(await caller("Bearer the-service-token")).toEqual({ kind: "service" });
    expect(await caller("bearer the-service-token")).toEqual({ kind: "service" });
    expect(await caller("Bearer the-service-token-not")).toEqual({ kind: "anonymous" });
  });

  it("admits an allowed operator's session and nobody else's", async () => {
    expect(await caller("Bearer ops-session")).toEqual({
      kind: "user",
      userId: "u-ops",
      name: "Ops",
      role: "admin",
    });
    expect(await caller("Bearer channel-session")).toEqual({ kind: "outsider" });
    expect(await caller("Bearer expired")).toEqual({ kind: "anonymous" });
  });

  it("admits a channel person whose Google link is live as a member", async () => {
    expect(await caller("Bearer member-session")).toEqual({
      kind: "member",
      userId: "u-m",
      person: ADA,
    });
  });

  it("finds the person behind a member and behind a linked operator", async () => {
    expect(await access.personOf(await caller("Bearer member-session"))).toEqual(ADA);
    expect(await access.personOf(await caller("Bearer ops-session"))).toEqual(ADA);
    expect(await access.personOf({ kind: "service" })).toBeUndefined();
  });

  it("resolves a request's caller once, however often it is asked", async () => {
    let lookups = 0;
    const counted = makeAccess({
      serviceToken: "s",
      auth: {
        sessionUser: async (token) => {
          lookups += 1;
          return sessions[token];
        },
        isAllowed: () => true,
      },
    });
    const request = new Request("http://localhost/x", {
      headers: { authorization: "Bearer ops-session" },
    });
    await counted.caller(request);
    await counted.caller(request);
    expect(lookups).toBe(1);
  });

  it("reads only the Bearer scheme", async () => {
    expect(await caller()).toEqual({ kind: "anonymous" });
    expect(await caller("Basic ops-session")).toEqual({ kind: "anonymous" });
  });
});

describe("policyFor", () => {
  it("needs a dashboard user for a route nobody classified", () => {
    expect(policyFor("GET", "/something-new")).toBe("user");
    expect(policyFor("POST", "/api/auth/*")).toBe("public");
    expect(policyFor("POST", "/inbound")).toBe("service");
    expect(policyFor("POST", "/workers/register")).toBe("token");
  });
});

describe("authorize", () => {
  it("answers 401 to nobody and 403 to the wrong somebody", () => {
    expect(authorize("user", { kind: "anonymous" })).toEqual({
      status: 401,
      error: "Unauthorized",
    });
    expect(authorize("user", { kind: "service" })).toMatchObject({ status: 403 });
    expect(
      authorize("service", { kind: "user", userId: "u", name: "U", role: "admin" }),
    ).toMatchObject({
      status: 403,
    });
    const member = { kind: "member", userId: "m", person: ADA } as const;
    expect(authorize("member", member)).toBeUndefined();
    expect(
      authorize("member", { kind: "user", userId: "u", name: "U", role: "admin" }),
    ).toBeUndefined();
    expect(authorize("user", member)).toMatchObject({ status: 403 });
    expect(authorize("member", { kind: "outsider" })).toMatchObject({ status: 403 });
    expect(authorize("public", { kind: "anonymous" })).toBeUndefined();
    expect(authorize("token", { kind: "anonymous" })).toBeUndefined();
  });

  it("admits no dashboard caller to a worker route (worker-access.ts does that)", () => {
    const admin = { kind: "user", userId: "a", name: "A", role: "admin" } as const;
    expect(authorize("worker", admin)).toMatchObject({ status: 403 });
    expect(authorize("worker", { kind: "service" })).toMatchObject({ status: 403 });
    expect(authorize("worker", { kind: "anonymous" })).toMatchObject({ status: 401 });
  });

  describe("role permissions", () => {
    const admin = { kind: "user", userId: "a", name: "A", role: "admin" } as const;
    const operatorMember = { kind: "user", userId: "o", name: "O", role: "member" } as const;
    const channelMember = { kind: "member", userId: "m", person: ADA } as const;
    const manageMembers = policyFor("POST", "/members/:key/role");

    it("lets an admin do everything and a member only read their own tickets", () => {
      expect(authorize(manageMembers, admin)).toBeUndefined();
      expect(authorize(policyFor("GET", "/projects"), admin)).toBeUndefined();
      for (const [method, route] of [
        ["GET", "/projects"],
        ["POST", "/projects/:id/sources"],
        ["GET", "/members"],
        ["GET", "/audit"],
        ["POST", "/shared-accounts"],
        ["POST", "/tickets/:id/status"],
      ] as const) {
        expect(authorize(policyFor(method, route), operatorMember)).toMatchObject({ status: 403 });
        expect(authorize(policyFor(method, route), channelMember)).toMatchObject({ status: 403 });
      }
      expect(authorize(policyFor("GET", "/me"), operatorMember)).toBeUndefined();
      expect(authorize(policyFor("GET", "/tickets/:id"), operatorMember)).toBeUndefined();
    });

    it("reads the role from a dashboard user or a channel member, and none from anyone else", () => {
      expect(roleOf(admin)).toBe("admin");
      expect(roleOf(channelMember)).toBe("member");
      expect(roleOf({ kind: "outsider" })).toBeUndefined();
    });

    it("answers 401 to an anonymous caller on a permission route", () => {
      expect(authorize(manageMembers, { kind: "anonymous" })).toMatchObject({ status: 401 });
    });

    it("keeps a route nobody listed for admins only", () => {
      expect(authorize(policyFor("GET", "/not-listed"), admin)).toBeUndefined();
      expect(authorize(policyFor("GET", "/not-listed"), operatorMember)).toMatchObject({
        status: 403,
      });
    });
  });
});
