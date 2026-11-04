import { describe, expect, it } from "vite-plus/test";
import type { WatcherConfig } from "./config.ts";
import { createWatcher, type McpClient } from "./poll.ts";
import type { Spawner } from "./spawn.ts";

const config: WatcherConfig = {
  mcpUrl: "http://mcp",
  workerId: "w1",
  workerType: "local_claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/tmp",
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
