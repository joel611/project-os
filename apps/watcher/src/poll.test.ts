import { describe, expect, it } from "vite-plus/test";
import type { WatcherConfig } from "./config.ts";
import { createWatcher, type McpClient } from "./poll.ts";
import type { Spawner } from "./spawn.ts";
import { collectLogger } from "./logger.ts";

const config: WatcherConfig = {
  mcpUrl: "http://mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  secret: "s3cret",
  skills: true,
  runLog: true,
  piAcp: false,
  piAcpCommand: ["pi-acp"],
  gitTimeoutMs: 600_000,
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
    spawn: (ticket) => {
      spawned.push(ticket?.id ?? "?");
      return new Promise<number>((r) => exits.push(r));
    },
  };
  const logs: string[] = [];
  const w = createWatcher({
    config: { ...config, ...cfg },
    client,
    spawner,
    logger: collectLogger(logs),
  });
  return { w, calls, spawned, exits, logs };
};

describe("watcher poll sessions per ticket", () => {
  it("starts each session for its own ticket, oldest first", async () => {
    const s = setup([{ id: "t1" }, { id: "t2" }, { id: "t3" }], { maxSessions: 2 });
    await s.w.pollOnce();
    expect(s.spawned).toEqual(["t1", "t2"]);
  });

  it("doesn't start a second session for a ticket whose session hasn't claimed it yet", async () => {
    const s = setup([{ id: "t1" }, { id: "t2" }], { maxSessions: 2 });
    await s.w.pollOnce();
    await s.w.pollOnce();
    expect(s.spawned).toEqual(["t1", "t2"]);
    // Once its session ends, a ticket still waiting gets a new one.
    s.exits[0]!(0);
    await Promise.resolve();
    await s.w.pollOnce();
    expect(s.spawned).toEqual(["t1", "t2", "t1"]);
  });
});

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
      logger: collectLogger(logs),
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
      logger: collectLogger(logs),
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

describe("cleaning up merged work", () => {
  const PR = "https://github.com/acme/web/pull/1";
  const PR2 = "https://github.com/acme/api/pull/2";
  const result = (body: string) => ({ type: "result", actor: "worker", body, payload: null });
  const merged = (url: string) => ({
    type: "system",
    actor: "coordinator",
    body: `PR merged: ${url}`,
    payload: { kind: "pull_request_settled", url, merged: true },
  });
  const ticket = (status: string, ...events: unknown[]) => ({ ticket: { status }, events });

  const setupCleanup = (
    tickets: Record<string, unknown>,
    options: { assigned?: () => unknown[]; gate?: Promise<void> } = {},
  ) => {
    const folders = new Set(Object.keys(tickets));
    const cleaned: string[] = [];
    const spawned: string[] = [];
    const exits: Array<(code: number) => void> = [];
    const logs: string[] = [];
    const w = createWatcher({
      config: { ...config, maxSessions: 5 },
      client: {
        callTool: async (name, args) => {
          if (name === "ticket_list_assigned") return { tickets: options.assigned?.() ?? [] };
          if (name !== "ticket_get") return {};
          const answer = tickets[args.ticketId as string];
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      spawner: {
        spawn: (t) => {
          spawned.push(t.id);
          return new Promise<number>((r) => exits.push(r));
        },
      },
      logger: collectLogger(logs),
      workspaces: {
        ticketIds: () => [...folders],
        cleanup: async (ticketId) => {
          cleaned.push(ticketId);
          await options.gate;
          return {
            removed: [`/ws/tickets/${ticketId}/web`],
            kept: [{ path: `/ws/tickets/${ticketId}/api`, reason: "dirty" }],
          };
        },
      },
    });
    return { w, cleaned, spawned, exits, logs };
  };

  it("cleans up only completed tickets whose every reported PR is merged", async () => {
    const s = setupCleanup({
      done: ticket("completed", result(`Done: ${PR} and ${PR2}`), merged(PR), merged(PR2)),
      half: ticket("completed", result(`Done: ${PR} and ${PR2}`), merged(PR)),
      noPr: ticket("completed", result("Done, no code change")),
      open: ticket("in_progress", result(PR), merged(PR)),
      odd: { ticket: { status: "completed" } },
      gone: new Error("This ticket isn't assigned to this worker."),
    });
    await s.w.pollOnce();
    expect(s.cleaned).toEqual(["done"]);
    expect(s.logs).toContain("workspace: cleaned up done, its PRs are merged");
    expect(s.logs).toContain("workspace: kept /ws/tickets/done/api: dirty");
  });

  it("cleans a ticket up once, and again only after a new session for it", async () => {
    let assigned: unknown[] = [];
    const s = setupCleanup(
      { t1: ticket("completed", result(PR), merged(PR)) },
      { assigned: () => assigned },
    );
    await s.w.pollOnce();
    await s.w.pollOnce();
    expect(s.cleaned).toEqual(["t1"]);

    // Reopened: a session runs, and once it is over the folder is looked at again.
    assigned = [{ id: "t1" }];
    await s.w.pollOnce();
    expect(s.spawned).toEqual(["t1"]);
    expect(s.cleaned).toEqual(["t1"]);
    assigned = [];
    s.exits[0]!(0);
    await new Promise((r) => setTimeout(r, 0));
    await s.w.pollOnce();
    expect(s.cleaned).toEqual(["t1", "t1"]);
  });

  it("holds a session back while its folder is cleaned up, even when polls overlap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let assigned: unknown[] = [];
    const s = setupCleanup(
      { t1: ticket("completed", result(PR), merged(PR)) },
      { assigned: () => assigned, gate },
    );
    const first = s.w.pollOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.cleaned).toEqual(["t1"]);

    // Reopened while its cleanup runs: the overlapping poll neither starts it nor cleans again.
    assigned = [{ id: "t1" }, { id: "t2" }];
    await s.w.pollOnce();
    expect(s.spawned).toEqual(["t2"]);
    expect(s.cleaned).toEqual(["t1"]);

    release();
    await first;
    await s.w.pollOnce();
    expect(s.spawned).toEqual(["t2", "t1"]);
  });
});
