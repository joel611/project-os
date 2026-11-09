import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { configDir, credentialsPath, loadCredentials, saveCredentials } from "./credentials.ts";
import { registerDevice } from "./register.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "watcher-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("credentials", () => {
  it("lives under PROJECT_OS_WATCHER_HOME, XDG_CONFIG_HOME, or ~/.config", () => {
    expect(credentialsPath({ PROJECT_OS_WATCHER_HOME: "/w" })).toBe("/w/watcher.json");
    expect(configDir({ XDG_CONFIG_HOME: "/x" })).toBe("/x/project-os");
    expect(configDir({})).toMatch(/\.config\/project-os$/);
    expect(credentialsPath()).toMatch(/project-os\/watcher\.json$/);
    expect(configDir()).toBe(credentialsPath().replace(/\/watcher\.json$/, ""));
  });

  it("round-trips, readable by this user only", () => {
    const path = join(dir, "nested", "watcher.json");
    expect(loadCredentials(path)).toBeUndefined();
    const creds = { server: "https://c", workerId: "local-1", name: "mbp", secret: "s" };
    saveCredentials(path, creds);
    expect(loadCredentials(path)).toEqual(creds);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps the agent and model chosen at register, and refuses an unknown agent", () => {
    const path = join(dir, "watcher.json");
    const creds = {
      server: "https://c",
      workerId: "local-1",
      name: "mbp",
      secret: "s",
      agent: "codex" as const,
      model: "gpt-5",
    };
    saveCredentials(path, creds);
    expect(loadCredentials(path)).toEqual(creds);
    writeFileSync(path, JSON.stringify({ ...creds, agent: "gemini" }));
    expect(() => loadCredentials(path)).toThrow(/unknown agent "gemini"/);
  });

  it("names the device by its id when the file has no name", () => {
    const path = join(dir, "watcher.json");
    writeFileSync(path, JSON.stringify({ server: "https://c", workerId: "local-1", secret: "s" }));
    expect(loadCredentials(path)?.name).toBe("local-1");
  });

  it("rejects an incomplete file", () => {
    const path = join(dir, "watcher.json");
    writeFileSync(path, JSON.stringify({ server: "https://c" }));
    expect(() => loadCredentials(path)).toThrow(/register/);
  });
});

describe("registerDevice", () => {
  it("posts the code and returns credentials for that server", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ workerId: "local-1", name: "mbp", secret: "s" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    const creds = await registerDevice(
      { server: "https://c/", token: "abc", name: "work laptop", hostname: "mbp" },
      fetcher,
    );
    expect(seen).toEqual({
      url: "https://c/workers/register",
      body: { token: "abc", name: "work laptop", hostname: "mbp" },
    });
    expect(creds).toEqual({ server: "https://c", workerId: "local-1", name: "mbp", secret: "s" });
  });

  it("reports other failures with their status", async () => {
    const fetcher = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(registerDevice({ server: "https://c", token: "x" }, fetcher)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("says when the code is no good", async () => {
    const fetcher = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(registerDevice({ server: "https://c", token: "x" }, fetcher)).rejects.toThrow(
      /expired, or already used/,
    );
  });
});
