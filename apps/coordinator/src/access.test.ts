import { describe, expect, it } from "vite-plus/test";
import { authorize, makeAccess } from "./access.ts";

const sessions: Record<string, { userId: string; email: string }> = {
  "ops-session": { userId: "u-ops", email: "Ops@Example.com" },
  "channel-session": { userId: "u-ch", email: "discord-1@people.project-os.invalid" },
};

const access = makeAccess({
  serviceToken: "the-service-token",
  auth: {
    sessionUser: async (token) => sessions[token],
    isAllowed: (email) => email.toLowerCase() === "ops@example.com",
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
    expect(await caller("Bearer ops-session")).toEqual({ kind: "user", userId: "u-ops" });
    expect(await caller("Bearer channel-session")).toEqual({ kind: "outsider" });
    expect(await caller("Bearer expired")).toEqual({ kind: "anonymous" });
  });

  it("reads only the Bearer scheme", async () => {
    expect(await caller()).toEqual({ kind: "anonymous" });
    expect(await caller("Basic ops-session")).toEqual({ kind: "anonymous" });
  });
});

describe("authorize", () => {
  it("answers 401 to nobody and 403 to the wrong somebody", () => {
    expect(authorize("user", { kind: "anonymous" })).toEqual({
      status: 401,
      error: "Unauthorized",
    });
    expect(authorize("user", { kind: "service" })).toMatchObject({ status: 403 });
    expect(authorize("service", { kind: "user", userId: "u" })).toMatchObject({ status: 403 });
    expect(authorize("public", { kind: "anonymous" })).toBeUndefined();
  });
});
