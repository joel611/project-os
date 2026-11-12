import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "./api.ts";
import { authBase, googleRefused, makeAuthClient } from "./auth.ts";

const COORD = "https://coord.test";

const answering = (response: () => Response) => {
  const seen: Request[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push(new Request(new URL(url, "http://dash.test"), init));
    return response();
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
};

const withToken = (token: string) => () =>
  new Response("{}", { headers: { "set-auth-token": token } });

describe("authBase", () => {
  it("is /api/auth on the Coordinator, or the dev proxy's /api/auth", () => {
    expect(authBase(undefined)).toBe("/api/auth");
    expect(authBase("https://coord.example.com/")).toBe("https://coord.example.com/api/auth");
  });
});

describe("signIn", () => {
  it("posts the email and password and returns the session token", async () => {
    const { fetchFn, seen } = answering(withToken("tok-1"));
    expect(await makeAuthClient(fetchFn, COORD).signIn("ops@example.com", "pw")).toBe("tok-1");
    expect(seen[0]!.url).toBe(`${COORD}/api/auth/sign-in/email`);
    expect(seen[0]!.method).toBe("POST");
    expect(await seen[0]!.json()).toEqual({ email: "ops@example.com", password: "pw" });
  });

  it("goes through the dev proxy without a Coordinator URL", async () => {
    const { fetchFn, seen } = answering(withToken("tok-1"));
    await makeAuthClient(fetchFn, undefined).signIn("a@b.c", "pw");
    expect(seen[0]!.url).toBe("http://dash.test/api/auth/sign-in/email");
  });

  it("returns null when the email and password don't match", async () => {
    const { fetchFn } = answering(() => new Response("{}", { status: 401 }));
    expect(await makeAuthClient(fetchFn, COORD).signIn("a@b.c", "wrong")).toBeNull();
  });

  it("fails on any other refusal, or a success without a token", async () => {
    const forbidden = answering(() => new Response("{}", { status: 403, statusText: "Forbidden" }));
    await expect(makeAuthClient(forbidden.fetchFn, COORD).signIn("a@b.c", "pw")).rejects.toEqual(
      new ApiError(403, "Forbidden"),
    );
    const tokenless = answering(() => new Response("{}"));
    await expect(makeAuthClient(tokenless.fetchFn, COORD).signIn("a@b.c", "pw")).rejects.toEqual(
      new ApiError(200, "NoSessionToken"),
    );
  });
});

describe("exchange", () => {
  it("trades a one-time token for the session token", async () => {
    const { fetchFn, seen } = answering(withToken("tok-2"));
    expect(await makeAuthClient(fetchFn, COORD).exchange("ott-1")).toBe("tok-2");
    expect(seen[0]!.url).toBe(`${COORD}/api/auth/one-time-token/verify`);
    expect(await seen[0]!.json()).toEqual({ token: "ott-1" });
  });

  it("returns null for a used or expired one-time token", async () => {
    const { fetchFn } = answering(() => new Response("{}", { status: 400 }));
    expect(await makeAuthClient(fetchFn, COORD).exchange("used")).toBeNull();
  });
});

describe("signOut", () => {
  it("ends the session with its Bearer token, and shrugs off a failure", async () => {
    const { fetchFn, seen } = answering(() => new Response("{}"));
    await makeAuthClient(fetchFn, COORD).signOut("tok-1");
    expect(seen[0]!.url).toBe(`${COORD}/api/auth/sign-out`);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-1");

    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(makeAuthClient(down, COORD).signOut("tok-1")).resolves.toBeUndefined();
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

describe("Google", () => {
  it("offers Google only when the Coordinator says so", async () => {
    const none = { google: false, googleDomains: [] };
    const on = answering(() => Response.json({ google: true }));
    expect(await makeAuthClient(on.fetchFn, COORD).providers()).toEqual({
      google: true,
      googleDomains: [],
    });
    expect(on.seen[0]!.url).toBe(`${COORD}/sign-in/providers`);
    const off = answering(() => Response.json({ google: false }));
    expect(await makeAuthClient(off.fetchFn, COORD).providers()).toEqual(none);
    const garbled = answering(() => new Response("<html>"));
    expect(await makeAuthClient(garbled.fetchFn, COORD).providers()).toEqual(none);
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await makeAuthClient(down, COORD).providers()).toEqual(none);
  });

  it("reads which domains Google sign-in is limited to, dropping anything but strings", async () => {
    const limited = answering(() =>
      Response.json({ google: true, googleDomains: ["acme.com", 7, "acme.io"] }),
    );
    expect(await makeAuthClient(limited.fetchFn, COORD).providers()).toEqual({
      google: true,
      googleDomains: ["acme.com", "acme.io"],
    });
  });

  it("names the allowed domains when Google turns someone away", () => {
    expect(googleRefused(["acme.com", "acme.io"])).toMatch(
      /only takes @acme\.com, @acme\.io accounts/,
    );
    expect(googleRefused([])).toMatch(/Ask an admin to add your email/);
  });

  it("starts at the Coordinator's Google route, directly or through the dev proxy", () => {
    expect(makeAuthClient(fetch, COORD).googleStartUrl).toBe(`${COORD}/sign-in/google`);
    expect(makeAuthClient(fetch, undefined).googleStartUrl).toBe("/api/sign-in/google");
  });
});
