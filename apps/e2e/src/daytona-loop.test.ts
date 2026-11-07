import { makeSandboxLauncher, type SandboxRunner } from "@project-os/infra-sandbox";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { type Stack, startStack } from "./stack.ts";

// Discord message -> daytona_pi Ticket -> sandbox launcher (pool: Daytona) -> session -> reply.
// The Daytona SDK is faked at the SandboxRunner seam. The sandbox's Pi session is played by an
// SDK MCP client that reads its worker id from the prompt the launcher hands the sandbox.

const LOCAL_WORKER = "local-claude-1";
const CHANNEL = "chan-1";

let stack: Stack;
let sessions: Promise<unknown>[];
let envs: Array<Readonly<Record<string, string>>>;
/** When set, the sandbox stays "running" and never touches the Coordinator. */
let hold: Promise<{ exitCode: number; output: string }> | undefined;

const playPiSession = async (env: Readonly<Record<string, string>>) => {
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
    body: "sandbox did it",
  });
  await tool("ticket_update_status", { ticketId, status: "completed" });
  return { exitCode: 0, output: "" };
};

const sandbox: SandboxRunner = {
  run: ({ env }) => {
    envs.push(env);
    if (hold) return hold;
    const session = playPiSession(env);
    sessions.push(session);
    return session;
  },
};

beforeEach(async () => {
  envs = [];
  sessions = [];
  hold = undefined;
  stack = await startStack({
    classifier: classifierReturning("new_request", 1, "daytona_pi"),
    workerId: LOCAL_WORKER,
    workerLauncher: makeSandboxLauncher({
      providers: [{ workerType: "daytona_pi", runner: sandbox }],
      mcpUrl: "https://tunnel.example/mcp",
      openrouterApiKey: "sk-or",
      model: "openrouter/m",
      prompt: "Work one ticket.",
      log: () => {},
    }),
  });
});
afterEach(() => stack.stop());

const say = async (content: string) => {
  const inbound = fakeInbound({ channelId: CHANNEL, userId: "u1", name: "Ada" }, content);
  await forwardInbound(stack.url, inbound!, fetch);
};

describe("daytona worker loop", () => {
  it("launches a sandbox under its own worker id, and its result reaches Discord", async () => {
    const projectId = await stack.linkChannel(CHANNEL);
    await say("add dark mode");
    await Promise.all(sessions);

    expect(envs).toHaveLength(1);
    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({
      status: "completed",
      workerType: "daytona_pi",
      workerId: `sandbox-daytona-${ticket.id}`,
    });
    expect(envs[0]!.PROJECT_OS_PROMPT).toContain(`sandbox-daytona-${ticket.id}`);
    expect(stack.posted.at(-1)!.content).toContain("sandbox did it");
  });

  it("keeps the host Watcher from picking up a daytona ticket", async () => {
    hold = new Promise(() => {});
    const projectId = await stack.linkChannel(CHANNEL);
    await say("add dark mode");

    const spawns: number[] = [];
    const watcher = createWatcher({
      config: {
        mcpUrl: `${stack.url}/mcp`,
        workerId: LOCAL_WORKER,
        workerType: "local_claude",
        intervalMs: 60_000,
        maxSessions: 1,
        cwd: "/tmp",
      },
      client: httpMcpClient(`${stack.url}/mcp`, fetch),
      spawner: { spawn: async () => spawns.push(1) },
      log: () => {},
    });
    await watcher.pollOnce();

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({ status: "assigned", workerType: "daytona_pi" });
    expect(spawns).toEqual([]);
  });
});
