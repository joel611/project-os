import { readFileSync } from "node:fs";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../discord-adapter/src/fake.ts";
import { forwardInbound } from "../../../discord-adapter/src/forward.ts";
import type { WatcherConfig } from "../../../watcher/src/config.ts";
import { httpMcpClient } from "../../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../../watcher/src/poll.ts";
import type { Spawner } from "../../../watcher/src/spawn.ts";
import { type Stack, startStack } from "./stack.ts";

// Watcher (real MCP client, real poll loop) against the real Coordinator /mcp.
// The spawned Claude Code session is played by an SDK MCP client following session-start.md.

const WORKER = "local-claude-1";
const CHANNEL = "chan-1";
const PROMPT = readFileSync(
  new URL("../../../watcher/prompts/session-start.md", import.meta.url),
  "utf8",
);

let stack: Stack;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request"), workerId: WORKER });
});
afterEach(() => stack.stop());

const watcherFor = (session: () => Promise<number>) => {
  const config: WatcherConfig = {
    mcpUrl: `${stack.url}/mcp`,
    workerId: WORKER,
    workerType: "local_claude",
    intervalMs: 60_000,
    maxSessions: 1,
    cwd: "/tmp",
  };
  const logs: string[] = [];
  const sessions: Promise<number>[] = [];
  const spawner: Spawner = {
    spawn: () => {
      const run = session();
      sessions.push(run);
      return run;
    },
  };
  const watcher = createWatcher({
    config,
    client: httpMcpClient(config.mcpUrl, fetch),
    spawner,
    log: (m) => logs.push(m),
  });
  return { watcher, logs, sessions };
};

const say = async (content: string) => {
  const inbound = fakeInbound({ channelId: CHANNEL, userId: "u1", name: "Ada" }, content);
  await forwardInbound(stack.url, inbound!, fetch);
};

/** Plays session-start.md the way a Claude Code Worker would. */
const claudeSession = async () => {
  const mcp = await stack.worker();
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: any;
    };
    expect(res.isError, `${name} failed`).toBeFalsy();
    return res.structuredContent;
  };
  const { tickets } = await tool("ticket_list_assigned", { workerId: WORKER });
  const ticketId = tickets[0].id as string;
  await tool("ticket_claim", { ticketId, workerId: WORKER });
  const { ticket } = await tool("ticket_get", { ticketId });
  await tool("project_memory_read", { projectId: ticket.projectId });
  await tool("ticket_append_event", {
    ticketId,
    type: "result",
    actor: "worker",
    actorId: WORKER,
    body: "added dark mode toggle",
  });
  await tool("ticket_update_status", { ticketId, status: "completed" });
  return 0;
};

describe("watcher loop", () => {
  it("spawns a session for an assigned ticket, and the session's result reaches Discord", async () => {
    const projectId = await stack.linkChannel(CHANNEL);
    await say("please add dark mode");

    const { watcher, logs, sessions } = watcherFor(claudeSession);
    await watcher.pollOnce();

    expect(logs.filter((l) => l.startsWith("poll failed"))).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(await sessions[0]).toBe(0);

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({ status: "completed", workerId: WORKER });
    expect(stack.posted).toHaveLength(1);
    expect(stack.posted[0]!.target).toEqual({ channelId: CHANNEL });
    expect(stack.posted[0]!.content).toContain("added dark mode toggle");
  });

  it("heartbeats and spawns nothing when no ticket is assigned", async () => {
    const { watcher, logs, sessions } = watcherFor(claudeSession);
    await watcher.pollOnce();
    expect(logs).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it("does not spawn again for a ticket its session already claimed", async () => {
    await stack.linkChannel(CHANNEL);
    await say("please add dark mode");
    const { watcher, sessions } = watcherFor(claudeSession);
    await watcher.pollOnce();
    await sessions[0];
    await watcher.pollOnce();
    expect(sessions).toHaveLength(1);
  });

  it("surfaces Coordinator tool errors through the watcher's MCP client", async () => {
    const client = httpMcpClient(`${stack.url}/mcp`, fetch);
    await expect(
      client.callTool("ticket_claim", { ticketId: "missing", workerId: WORKER }),
    ).rejects.toThrow(/^MCP ticket_claim: /);
  });
});

describe("worker prompt contract", () => {
  it("names only tools the Coordinator serves", async () => {
    const mcp = await stack.worker();
    const served = new Set((await mcp.listTools()).tools.map((t) => t.name));
    const named = [...PROMPT.matchAll(/`((?:ticket|project)_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !served.has(name!))).toEqual([]);
  });
});

describe("AI provider isolation", () => {
  it("blocks any fetch that leaves localhost", () => {
    expect(() => fetch("https://openrouter.ai/api/v1/chat/completions")).toThrow(
      /blocked external fetch/,
    );
  });
});
