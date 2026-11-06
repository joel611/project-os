import { DEFAULT_WORKER_ID } from "@project-os/config";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadConfig } from "./config.ts";

const KEYS = ["MCP_URL", "WORKER_ID", "POLL_INTERVAL_MS", "MAX_SESSIONS", "WORKER_CWD"];

describe("loadConfig", () => {
  // Clear before as well as after: a local .env (auto-loaded by Bun) may set these.
  const clearEnv = () => {
    for (const k of KEYS) delete process.env[k];
  };
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("defaults to the shared worker id", () => {
    const c = loadConfig();
    expect(c.workerId).toBe(DEFAULT_WORKER_ID);
    expect(c.workerType).toBe("local_claude");
    expect(c.intervalMs).toBe(300_000);
    expect(c.maxSessions).toBe(1);
    expect(c.cwd).toBe(process.cwd());
  });

  it("reads overrides from env", () => {
    process.env.MCP_URL = "http://x/mcp";
    process.env.WORKER_ID = "w9";
    process.env.POLL_INTERVAL_MS = "1000";
    process.env.MAX_SESSIONS = "3";
    process.env.WORKER_CWD = "/work";
    expect(loadConfig()).toEqual({
      mcpUrl: "http://x/mcp",
      workerId: "w9",
      workerType: "local_claude",
      intervalMs: 1000,
      maxSessions: 3,
      cwd: "/work",
    });
  });

  it("uses saved credentials as a personal worker", () => {
    const c = loadConfig({ server: "https://c", workerId: "local-9", name: "mbp", secret: "s" });
    expect(c).toMatchObject({ mcpUrl: "https://c/mcp", workerId: "local-9", secret: "s" });
  });
});
