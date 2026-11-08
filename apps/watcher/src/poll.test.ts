import { describe, expect, it } from "vite-plus/test";
import type { WatcherConfig } from "./config.ts";
import { createWatcher, type McpClient } from "./poll.ts";
import type { Spawner } from "./spawn.ts";

const config: WatcherConfig = {
  mcpUrl: "http://mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/tmp",
  secret: "s3cret",
};

const setup = (assigned: unknown[], cfg: Partial<WatcherConfig> = {}) => {
  const calls: string[] = [];
  const client: McpClient = {
    callTool: async (name) => {
      calls.push(name);
      return name === "ticket_list_assigned" ? { tickets: assigned } : { lastSeenAt: "t" };
    },
  };
  const exits: Array<(code: number) => void> = [];
  const spawned: string[] = [];
  const spawner: Spawner = {
    spawn: () => {
      spawned.push("claude");
      return new Promise<number>((r) => exits.push(r));
    },
  };
  const logs: string[] = [];
  const w = createWatcher({
    config: { ...config, ...cfg },
    client,
    spawner,
    log: (m) => logs.push(m),
  });
  return { w, calls, spawned, exits, logs };
};

describe("watcher poll", () => {
  it("heartbeats then lists, in order", async () => {
    const s = setup([]);
    await s.w.pollOnce();
    expect(s.calls).toEqual(["worker_heartbeat", "ticket_list_assigned"]);
    expect(s.spawned).toEqual([]);
  });

  it("spawns one session when work exists", async () => {
    const s = setup([{ id: "t1" }]);
    await s.w.pollOnce();
    expect(s.spawned).toHaveLength(1);
    expect(s.w.running()).toBe(1);
  });

  it("does not spawn when at capacity, still heartbeats", async () => {
    const s = setup([{ id: "t1" }]);
    await s.w.pollOnce();
    await s.w.pollOnce();
    expect(s.spawned).toHaveLength(1);
    expect(s.calls.filter((c) => c === "worker_heartbeat")).toHaveLength(2);
  });

  it("frees capacity when a session exits", async () => {
    const s = setup([{ id: "t1" }]);
    await s.w.pollOnce();
    s.exits[0]!(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.w.running()).toBe(0);
    await s.w.pollOnce();
    expect(s.spawned).toHaveLength(2);
    expect(s.logs.some((l) => l.includes("exit"))).toBe(true);
  });

  it("spawns up to maxSessions, capped by ticket count", async () => {
    const s = setup([{ id: "a" }, { id: "b" }], { maxSessions: 3 });
    await s.w.pollOnce();
    expect(s.spawned).toHaveLength(2);
  });

  it("survives an MCP failure", async () => {
    const logs: string[] = [];
    const w = createWatcher({
      config,
      client: {
        callTool: async () => {
          throw new Error("down");
        },
      },
      spawner: { spawn: async () => 0 },
      log: (m) => logs.push(m),
    });
    await expect(w.pollOnce()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("down"))).toBe(true);
  });
});

describe("watcher poll error reporting", () => {
  const run = async (spawn: () => Promise<number>, callTool?: McpClient["callTool"]) => {
    const logs: string[] = [];
    const w = createWatcher({
      config,
      client: { callTool: callTool ?? (async () => ({ tickets: [{ id: "t" }] })) },
      spawner: { spawn },
      log: (m) => logs.push(m),
    });
    await w.pollOnce();
    await new Promise((r) => setTimeout(r, 0));
    return { w, logs };
  };

  it("logs and frees capacity when a session rejects with an Error", async () => {
    const { w, logs } = await run(() => Promise.reject(new Error("boom")));
    expect(logs.some((l) => l.includes("error=boom"))).toBe(true);
    expect(w.running()).toBe(0);
  });

  it("logs a non-Error rejection", async () => {
    const { logs } = await run(() => Promise.reject("weird"));
    expect(logs.some((l) => l.includes("error=weird"))).toBe(true);
  });

  it("logs a non-Error poll failure", async () => {
    const { logs } = await run(
      async () => 0,
      async () => Promise.reject("nope"),
    );
    expect(logs.some((l) => l.includes("poll failed: nope"))).toBe(true);
  });
});
