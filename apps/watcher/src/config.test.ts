import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadConfig } from "./config.ts";

const KEYS = ["POLL_INTERVAL_MS", "MAX_SESSIONS", "WORKER_CWD", "WATCHER_AGENT", "WATCHER_MODEL"];
const credentials = { server: "https://c", workerId: "local-9", name: "mbp", secret: "s" };
const installed =
  (...names: string[]) =>
  (command: string) =>
    names.includes(command);

describe("loadConfig", () => {
  // Clear before as well as after: a local .env (auto-loaded by Bun) may set these.
  const clearEnv = () => {
    for (const k of KEYS) delete process.env[k];
  };
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("serves as the registered device, with defaults", () => {
    expect(loadConfig(credentials, installed("claude"))).toEqual({
      mcpUrl: "https://c/mcp",
      workerId: "local-9",
      workerType: "local",
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
    expect(loadConfig(credentials, installed())).toMatchObject({
      intervalMs: 1000,
      maxSessions: 3,
      cwd: "/work",
    });
  });

  describe("agent", () => {
    it("uses the one saved at register while its CLI is installed", () => {
      const saved = { ...credentials, agent: "pi" as const, model: "m1" };
      expect(loadConfig(saved, installed("claude", "pi"))).toMatchObject({
        agent: "pi",
        model: "m1",
      });
    });

    it("detects the installed CLI when none was saved", () => {
      expect(loadConfig(credentials, installed("pi", "codex"))).toMatchObject({ agent: "pi" });
    });

    it("switches to an installed CLI when the saved one is gone, and drops its model", () => {
      const saved = { ...credentials, agent: "claude" as const, model: "opus" };
      const config = loadConfig(saved, installed("codex"));
      expect(config.agent).toBe("codex");
      expect(config).not.toHaveProperty("model");
    });

    it("keeps a saved model when no agent was saved with it", () => {
      const saved = { ...credentials, model: "m1" };
      expect(loadConfig(saved, installed("pi"))).toMatchObject({ agent: "pi", model: "m1" });
    });

    it("keeps the saved choice when nothing is installed, so the failure names that CLI", () => {
      const saved = { ...credentials, agent: "codex" as const };
      expect(loadConfig(saved, installed()).agent).toBe("codex");
      expect(loadConfig(credentials, installed()).agent).toBe("claude");
    });

    it("lets WATCHER_AGENT and WATCHER_MODEL override, without checking PATH", () => {
      const saved = { ...credentials, agent: "pi" as const, model: "m1" };
      process.env.WATCHER_AGENT = "codex";
      process.env.WATCHER_MODEL = "m2";
      expect(loadConfig(saved, installed("pi"))).toMatchObject({ agent: "codex", model: "m2" });
    });

    it("rejects an unknown WATCHER_AGENT", () => {
      process.env.WATCHER_AGENT = "gemini";
      expect(() => loadConfig(credentials, installed("claude"))).toThrow(/claude, pi, codex/);
    });
  });
});
