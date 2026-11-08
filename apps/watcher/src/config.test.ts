import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadConfig } from "./config.ts";

const KEYS = ["POLL_INTERVAL_MS", "MAX_SESSIONS", "WORKER_CWD", "WATCHER_AGENT", "WATCHER_MODEL"];
const credentials = { server: "https://c", workerId: "local-9", name: "mbp", secret: "s" };

describe("loadConfig", () => {
  // Clear before as well as after: a local .env (auto-loaded by Bun) may set these.
  const clearEnv = () => {
    for (const k of KEYS) delete process.env[k];
  };
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("serves as the registered device, with defaults", () => {
    expect(loadConfig(credentials)).toEqual({
      mcpUrl: "https://c/mcp",
      workerId: "local-9",
      workerType: "local_claude",
      agent: "claude",
      intervalMs: 300_000,
      maxSessions: 1,
      cwd: process.cwd(),
      secret: "s",
    });
  });

  it("reads overrides from env", () => {
    process.env.POLL_INTERVAL_MS = "1000";
    process.env.MAX_SESSIONS = "3";
    process.env.WORKER_CWD = "/work";
    expect(loadConfig(credentials)).toMatchObject({
      intervalMs: 1000,
      maxSessions: 3,
      cwd: "/work",
    });
  });

  it("picks the agent and model from env", () => {
    process.env.WATCHER_AGENT = "codex";
    process.env.WATCHER_MODEL = "gpt-5";
    expect(loadConfig(credentials)).toMatchObject({ agent: "codex", model: "gpt-5" });
  });

  it("rejects an unknown agent", () => {
    process.env.WATCHER_AGENT = "gemini";
    expect(() => loadConfig(credentials)).toThrow(/claude, pi, codex/);
  });
});
