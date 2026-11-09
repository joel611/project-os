import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "./api.ts";
import { authBase, makeAuthClient } from "./auth.ts";

const answering = (response: () => Response) => {
  const seen: Request[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push(new Request(new URL(url, "http://dash.test"), init));
    return response();
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
};

describe("authBase", () => {
  it("is /api/auth on the Coordinator, or the dev proxy's /api/auth", () => {
    expect(authBase(undefined)).toBe("/api/auth");
    expect(authBase("https://coord.example.com/")).toBe("https://coord.example.com/api/auth");
  });
});

describe("signIn", () => {
  it("posts the email and password and returns the session token", async () => {
    const { fetchFn, seen } = answering(
      () => new Response("{}", { headers: { "set-auth-token": "tok-1" } }),
    );
    expect(await makeAuthClient(fetchFn, "/api/auth").signIn("ops@example.com", "pw")).toBe(
      "tok-1",
    );
    expect(seen[0]!.url).toBe("http://dash.test/api/auth/sign-in/email");
    expect(seen[0]!.method).toBe("POST");
    expect(await seen[0]!.json()).toEqual({ email: "ops@example.com", password: "pw" });
  });

  it("returns null when the email and password don't match", async () => {
    const { fetchFn } = answering(() => new Response("{}", { status: 401 }));
    expect(await makeAuthClient(fetchFn, "/api/auth").signIn("a@b.c", "wrong")).toBeNull();
  });

  it("fails on any other refusal, or a success without a token", async () => {
    const forbidden = answering(() => new Response("{}", { status: 403, statusText: "Forbidden" }));
    await expect(
      makeAuthClient(forbidden.fetchFn, "/api/auth").signIn("a@b.c", "pw"),
    ).rejects.toEqual(new ApiError(403, "Forbidden"));
    const tokenless = answering(() => new Response("{}"));
    await expect(
      makeAuthClient(tokenless.fetchFn, "/api/auth").signIn("a@b.c", "pw"),
    ).rejects.toEqual(new ApiError(200, "NoSessionToken"));
  });
});

describe("signOut", () => {
  it("ends the session with its Bearer token, and shrugs off a failure", async () => {
    const { fetchFn, seen } = answering(() => new Response("{}"));
    await makeAuthClient(fetchFn, "/api/auth").signOut("tok-1");
    expect(seen[0]!.url).toBe("http://dash.test/api/auth/sign-out");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-1");

    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(makeAuthClient(down, "/api/auth").signOut("tok-1")).resolves.toBeUndefined();
  });

  it("uses the global fetch by default", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    try {
      await expect(makeAuthClient().signOut("t")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
