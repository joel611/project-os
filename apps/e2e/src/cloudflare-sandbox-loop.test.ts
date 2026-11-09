import { cloudflareSandboxRunnerLive } from "@project-os/sandbox-cloudflare";
import { handleBridge, type SandboxStubLike } from "@project-os/sandbox-cloudflare/bridge";
import { makeSandboxLauncher, type SandboxRunner } from "@project-os/sandbox-core";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { type Stack, startStack } from "./stack.ts";

// Discord message -> Ticket -> sandbox pool -> Cloudflare Sandbox runner -> bridge Worker
// (handleBridge on a localhost port) -> sandbox process -> reply. Only `@cloudflare/sandbox`'s
// Durable Object stub is faked; it plays the Pi session over MCP, like the Daytona suite.

const CHANNEL = "chan-1";
const TOKEN = "bridge-secret";

let stack: Stack;
let bridge: ReturnType<typeof Bun.serve>;
let sessions: Promise<void>[];
let destroyed: string[];
let daytonaRuns: number;
/** Sandboxes stay "running" and never touch the Coordinator while set. */
let hold: boolean;

const playPiSession = async (env: Record<string, string>) => {
  const workerId = /worker_id is `([^`]+)`/.exec(env.PROJECT_OS_PROMPT!)![1]!;
  const mcp = await stack.worker();
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: any;
    };
    expect(res.isError, `${name} failed`).toBeFalsy();
    return res.structuredContent;
  };
  const { tickets } = await tool("ticket_list_assigned", { workerId });
  const ticketId = tickets[0].id as string;
  await tool("ticket_claim", { ticketId, workerId });
  await tool("ticket_append_event", {
    ticketId,
    type: "result",
    actor: "worker",
    actorId: workerId,
    body: "cloudflare did it",
  });
  await tool("ticket_update_status", { ticketId, status: "completed" });
};

/** A fake Sandbox Durable Object per id: one process, done once its Pi session is. */
const sandboxes = new Map<string, { done: boolean; envs: Record<string, string>[] }>();
const stub = (id: string): SandboxStubLike => {
  const box = sandboxes.get(id) ?? { done: false, envs: [] };
  sandboxes.set(id, box);
  return {
    startProcess: async (_command, { env }) => {
      box.envs.push(env);
      if (hold) return;
      sessions.push(playPiSession(env).then(() => void (box.done = true)));
    },
    getProcess: async () =>
      box.done ? { status: "completed", exitCode: 0 } : { status: "running" },
    getProcessLogs: async () => ({ stdout: "ok", stderr: "" }),
    destroy: async () => void destroyed.push(id),
  };
};

const daytona: SandboxRunner = {
  run: () => {
    daytonaRuns++;
    return new Promise(() => {});
  },
};

const start = async (pool: "cloudflare" | "cloudflare-capped") => {
  const runner = cloudflareSandboxRunnerLive({
    url: `http://localhost:${bridge.port}`,
    token: TOKEN,
    pollMs: 20,
  });
  let next = 0;
  bridge.reload({
    fetch: (req) =>
      handleBridge(req, { token: TOKEN, sandbox: stub, newId: () => `sbx-${++next}` }),
  });
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    workerLauncher: makeSandboxLauncher({
      providers: [
        {
          workerType: "cloudflare_pi",
          runner,
          ...(pool === "cloudflare-capped" ? { maxConcurrent: 1 } : {}),
        },
        { workerType: "daytona_pi", runner: daytona },
      ],
      mcpUrl: "https://tunnel.example/mcp",
      openrouterApiKey: "sk-or",
      model: "openrouter/m",
      prompt: "Work one ticket.",
      log: () => {},
    }),
  });
};

beforeEach(() => {
  sessions = [];
  destroyed = [];
  daytonaRuns = 0;
  hold = false;
  sandboxes.clear();
  bridge = Bun.serve({ port: 0, fetch: () => new Response("not ready", { status: 503 }) });
});
afterEach(async () => {
  await stack?.stop();
  bridge.stop(true);
});

const say = async (content: string) => {
  const inbound = fakeInbound({ channelId: CHANNEL, userId: "u1", name: "Ada" }, content);
  await forwardInbound(stack.coordinator, inbound!, fetch);
};

/** Waits until `check` passes; the runner polls the bridge on a timer. */
const eventually = async (check: () => void | Promise<void>, ms = 10_000) => {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
};

describe("cloudflare sandbox worker loop", () => {
  it("starts the pool's first provider through the bridge, and its result reaches Discord", async () => {
    await start("cloudflare");
    const projectId = await stack.linkChannel(CHANNEL);
    await say("add dark mode");
    await eventually(() => expect(sessions).toHaveLength(1));
    await Promise.all(sessions);

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({
      status: "completed",
      workerType: "cloudflare_pi",
      workerId: `cloudflare-${ticket.id}`,
    });
    const box = sandboxes.get("sbx-1")!;
    expect(box.envs[0]!.PROJECT_OS_PROMPT).toContain(`cloudflare-${ticket.id}`);
    expect(box.envs[0]!.OPENROUTER_API_KEY).toBe("sk-or");
    expect(daytonaRuns).toBe(0);
    await eventually(() => expect(stack.posted.at(-1)?.content).toContain("cloudflare did it"));
    // The runner sees the process exit and destroys the sandbox.
    await eventually(() => expect(destroyed).toEqual(["sbx-1"]));
  });

  it("sends the next ticket to Daytona once Cloudflare is at its cap", async () => {
    hold = true;
    await start("cloudflare-capped");
    const projectId = await stack.linkChannel(CHANNEL);
    await say("add dark mode");
    await eventually(() => expect(sandboxes.size).toBe(1));
    await say("add light mode");
    await eventually(() => expect(daytonaRuns).toBe(1));

    const tickets = (await stack.json("GET", `/projects/${projectId}/tickets`)) as Array<{
      workerType: string;
    }>;
    expect(tickets.map((t) => t.workerType).sort()).toEqual(["cloudflare_pi", "daytona_pi"]);
  });

  it("refuses bridge calls without the token", async () => {
    await start("cloudflare");
    const res = await fetch(`http://localhost:${bridge.port}/sessions`, {
      method: "POST",
      body: JSON.stringify({ command: "true", env: {} }),
    });
    expect(res.status).toBe(401);
    expect(sandboxes.size).toBe(0);
  });
});
