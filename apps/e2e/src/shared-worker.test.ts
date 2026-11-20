import { WORKER_SESSION_START } from "@project-os/system-prompts";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import type { Spawner } from "../../watcher/src/spawn.ts";
import { ADMIN_CHANNEL, ADMIN_USER, type Stack, startStack } from "./stack.ts";
import { collectLogger } from "../../watcher/src/logger.ts";

// A shared worker: an admin runs `/register-worker shared:True`, the Watcher on that computer
// trades the code for credentials, then (real MCP client, real poll loop, against the real
// Coordinator /mcp) works tickets from anyone without their own worker online. The spawned
// Claude Code session is played by an SDK MCP client following the Worker session-start prompt.

const CHANNEL = "chan-1";
const PROMPT = WORKER_SESSION_START;

let stack: Stack;
let WORKER: string;
let SECRET: string;
beforeEach(async () => {
  // Production's cap: one ticket per shared device at a time.
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    sharedWorkerMaxTickets: 1,
  });
  ({ workerId: WORKER, secret: SECRET } = await stack.registerSharedWorker());
});
afterEach(() => stack.stop());

const watcherFor = (session: () => Promise<number>) => {
  const config = loadConfig(
    { server: stack.url, workerId: WORKER, name: "box", secret: SECRET },
    () => true,
  );
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
    client: httpMcpClient(config.mcpUrl, fetch, config.secret),
    spawner,
    logger: collectLogger(logs),
  });
  return { watcher, logs, sessions };
};

const say = async (content: string, userId = "u1") => {
  const inbound = fakeInbound({ channelId: CHANNEL, userId, name: "Ada" }, content);
  await forwardInbound(stack.coordinator, inbound!, fetch);
};

/** Plays the Worker session-start prompt the way a Claude Code Worker would. */
const claudeSession = async () => {
  const mcp = await stack.worker(SECRET);
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

describe("shared worker loop", () => {
  it("joins the pool from an admin's code, and works anyone's ticket through to Discord", async () => {
    const projectId = await stack.linkChannel(CHANNEL);
    await say("please add dark mode");

    const { watcher, logs, sessions } = watcherFor(claudeSession);
    await watcher.pollOnce();

    expect(logs.filter((l) => l.startsWith("poll failed"))).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(await sessions[0]).toBe(0);

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({ status: "completed", workerId: WORKER });
    // [0] is the thread-opened note; the result follows in the same thread.
    expect(stack.posted).toHaveLength(2);
    expect(stack.posted[1]!.target).toEqual({ channelId: CHANNEL, threadId: "discord-thread-1" });
    expect(stack.posted[1]!.content).toContain("added dark mode toggle");
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
    const client = httpMcpClient(`${stack.url}/mcp`, fetch, SECRET);
    await expect(
      client.callTool("ticket_claim", { ticketId: "missing", workerId: WORKER }),
    ).rejects.toThrow(/^MCP ticket_claim: /);
  });

  it("refuses anyone acting as the shared worker without its secret", async () => {
    const anon = httpMcpClient(`${stack.url}/mcp`, fetch);
    await expect(anon.callTool("ticket_list_assigned", { workerId: WORKER })).rejects.toThrow(
      /HTTP 401/,
    );
    const sandbox = await stack.worker(await stack.sandboxToken("daytona-elsewhere"));
    const res = (await sandbox.callTool({
      name: "ticket_list_assigned",
      arguments: { workerId: WORKER },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("WorkerUnauthorized");
  });

  it("queues a ticket while the shared worker is busy and nothing else has room", async () => {
    const projectId = await stack.linkChannel(CHANNEL);
    await say("please add dark mode");
    await say("and write release notes", "u2");

    const tickets = (await stack.json("GET", `/projects/${projectId}/tickets`)) as any[];
    const byTitle = (t: string) => tickets.find((x) => x.title === t);
    expect(byTitle("please add dark mode")).toMatchObject({ status: "assigned", workerId: WORKER });
    expect(byTitle("and write release notes")).toMatchObject({ status: "open", workerId: null });
    expect(stack.posted.at(-1)).toMatchObject({
      target: { channelId: CHANNEL, threadId: "discord-thread-2" },
      content: expect.stringContaining("queued"),
    });
  });

  it("lets only admins, in the admin channel, register a shared worker", async () => {
    const run = (channelId: string, userId: string) =>
      forwardCommand(
        stack.coordinator,
        fakeCommand({ channelId, userId, name: "X" }, "register-worker", { shared: "true" })!,
        fetch,
      );
    expect((await run(CHANNEL, ADMIN_USER)).content).toContain("only works in the admin channel");
    expect((await run(ADMIN_CHANNEL, "u1")).content).toContain("Not authorized");
  });
});

describe("worker prompt contract", () => {
  it("names only tools the Coordinator serves", async () => {
    const mcp = await stack.worker(SECRET);
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
