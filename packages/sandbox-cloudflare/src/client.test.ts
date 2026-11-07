import { describe, expect, it } from "vite-plus/test";
import { cloudflareSandboxRunner } from "./client.ts";
import type { SessionStatus } from "./protocol.ts";

const input = { env: { K: "v" }, command: "run-it", timeoutSeconds: 60 };

/** A bridge that reports `polls` in turn on GET, recording every request. */
const fakeBridge = (
  polls: SessionStatus[],
  overrides: { failStart?: boolean; failDelete?: boolean; unreadableError?: boolean } = {},
) => {
  const calls: Array<{ method: string; path: string; auth: string | null; body?: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization");
    calls.push({
      method,
      path,
      auth,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "POST") {
      if (overrides.unreadableError) {
        return {
          ok: false,
          status: 502,
          text: () => Promise.reject(new Error("socket closed")),
        } as unknown as Response;
      }
      return overrides.failStart
        ? new Response("no capacity", { status: 503 })
        : Response.json({ id: "s1" }, { status: 201 });
    }
    if (method === "DELETE" && overrides.failDelete) throw new Error("gone");
    if (method === "GET") return Response.json(polls.shift() ?? { state: "running" });
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

const runner = (fetch: typeof globalThis.fetch, now = () => 0) =>
  cloudflareSandboxRunner({
    url: "https://bridge.example/",
    token: "tok",
    fetch,
    sleep: async () => {},
    now,
  });

describe("cloudflare sandbox runner", () => {
  it("starts a session, polls to exit, returns its output, then destroys it", async () => {
    const bridge = fakeBridge([
      { state: "running" },
      { state: "exited", exitCode: 0, output: "done" },
    ]);
    expect(await runner(bridge.fetch).run(input)).toEqual({ exitCode: 0, output: "done" });
    expect(bridge.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /sessions",
      "GET /sessions/s1",
      "GET /sessions/s1",
      "DELETE /sessions/s1",
    ]);
    expect(bridge.calls[0]!.body).toEqual({ env: { K: "v" }, command: "run-it" });
    expect(bridge.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("gives up after the timeout and still destroys the sandbox", async () => {
    const bridge = fakeBridge([]);
    let t = 0;
    const run = runner(bridge.fetch, () => (t += 30_000)).run(input);
    await expect(run).rejects.toThrow("session exceeded 60s");
    expect(bridge.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/sessions/s1" });
  });

  it("returns the result even when destroying the sandbox fails", async () => {
    const bridge = fakeBridge([{ state: "exited", exitCode: 1, output: "x" }], {
      failDelete: true,
    });
    expect(await runner(bridge.fetch).run(input)).toEqual({ exitCode: 1, output: "x" });
  });

  it("reports a bridge error whose body can't be read by status alone", async () => {
    const bridge = fakeBridge([], { unreadableError: true });
    await expect(runner(bridge.fetch).run(input)).rejects.toThrow(
      /^cloudflare sandbox POST \/sessions: 502$/,
    );
  });

  it("surfaces a bridge error with its status and body", async () => {
    const bridge = fakeBridge([], { failStart: true });
    await expect(runner(bridge.fetch).run(input)).rejects.toThrow(
      "cloudflare sandbox POST /sessions: 503 no capacity",
    );
  });
});
