import { makeSandboxLauncher, type SandboxRunner } from "@project-os/sandbox-core";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import {
  fakeCommand,
  fakeInbound,
  type FakeSpeaker,
} from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// SANDBOX_CREDENTIAL_PROXY on: Discord message -> daytona_pi Ticket -> sandbox session, which
// calls GitHub through the Coordinator's /egress with its own MCP token. The Coordinator adds
// the requester's linked token (from the fake OAuth server) on the way to a fake GitHub on
// localhost, so the session, and the model in it, never holds that token.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };

let stack: Stack;
let sessions: Promise<unknown>[];
let envs: Array<Readonly<Record<string, string>>>;
/** What the sandbox saw: tool names, tool results and proxied responses. */
let seen: string[];
/** Requests that reached fake GitHub. */
let upstream: Array<{ path: string; authorization: string | null }>;
let github: ReturnType<typeof Bun.serve>;

const playPiSession = async (env: Readonly<Record<string, string>>) => {
  const workerId = /worker_id is `([^`]+)`/.exec(env.PROJECT_OS_PROMPT!)![1]!;
  const mcp = await stack.worker(env.PROJECT_OS_EGRESS_TOKEN!);
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  seen.push(JSON.stringify(tools));
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { structuredContent?: any };
    seen.push(JSON.stringify(res));
    return res.structuredContent;
  };
  const { tickets } = await tool("ticket_list_assigned", { workerId });
  const ticketId = tickets[0].id as string;
  await tool("ticket_claim", { ticketId, workerId });
  // What `curl "$PROJECT_OS_EGRESS_URL/github/user" -H "Authorization: Bearer $PROJECT_OS_EGRESS_TOKEN"`
  // does, sent to the stack's Coordinator in place of the public tunnel URL.
  const egress = new URL(env.PROJECT_OS_EGRESS_URL!).pathname;
  const res = await fetch(`${stack.url}${egress}/github/user`, {
    headers: { authorization: `Bearer ${env.PROJECT_OS_EGRESS_TOKEN}` },
  });
  const body = await res.text();
  seen.push(body);
  await tool("ticket_append_event", {
    ticketId,
    type: "result",
    actor: "worker",
    actorId: workerId,
    body: `github said ${res.status}: ${body}`,
  });
  await tool("ticket_update_status", { ticketId, status: res.ok ? "completed" : "blocked" });
  return { exitCode: 0, output: "" };
};

const sandbox: SandboxRunner = {
  run: ({ env }) => {
    envs.push(env);
    const session = playPiSession(env);
    sessions.push(session);
    return session;
  },
};

beforeEach(async () => {
  envs = [];
  sessions = [];
  seen = [];
  upstream = [];
  github = Bun.serve({
    port: 0,
    fetch: (req) => {
      upstream.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ login: "ada" });
    },
  });
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    connections: true,
    credentialProxy: { origins: { github: `http://localhost:${github.port}` } },
    workerLauncher: makeSandboxLauncher({
      providers: [{ workerType: "daytona_pi", runner: sandbox }],
      mcpUrl: "https://tunnel.example/mcp",
      egressUrl: "https://tunnel.example/egress",
      openrouterApiKey: "sk-or",
      model: "openrouter/m",
      log: () => {},
    }),
  });
});
afterEach(async () => {
  await stack.stop();
  await github.stop(true);
});

const say = async (content: string) => {
  await forwardInbound(stack.coordinator, fakeInbound(ada, content)!, fetch);
};

const connectGitHub = async () => {
  const reply = await forwardCommand(
    stack.coordinator,
    fakeCommand(ada, "connect", { provider: "github" })!,
    fetch,
  );
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  expect((await browse(link, undefined, "POST")).status).toBe(200);
};

describe("credential proxy", () => {
  it("calls GitHub as the requester without the sandbox ever holding their token", async () => {
    await connectGitHub();
    const projectId = await stack.linkChannel(CHANNEL);
    await say("summarize my open PRs");
    await Promise.all(sessions);

    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket).toMatchObject({ status: "completed", workerType: "daytona_pi" });
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.path).toBe("/user");
    const authorization = upstream[0]!.authorization!;
    expect(authorization).toMatch(/^Bearer at-github-/);

    // The person's token went to GitHub only: not into the sandbox, its prompt or any tool result.
    const personToken = authorization.replace(/^Bearer /, "");
    const sandboxSaw = [...seen, ...envs.flatMap((e) => Object.values(e))].join("\n");
    expect(sandboxSaw).not.toContain(personToken);
    expect(seen[0]).not.toContain("user_token");
    expect(envs[0]!.PROJECT_OS_PROMPT).toContain("$PROJECT_OS_EGRESS_URL");
    expect(stack.posted.at(-1)!.content).toContain('"login":"ada"');
  });

  it("refuses with NotConnected and asks the requester to connect", async () => {
    const projectId = await stack.linkChannel(CHANNEL);
    await say("summarize my open PRs");
    await Promise.all(sessions);

    expect(upstream).toEqual([]);
    const [ticket] = await stack.json("GET", `/projects/${projectId}/tickets`);
    expect(ticket.status).toBe("blocked");
    expect(seen.some((s) => s.includes("NotConnected"))).toBe(true);
    expect(stack.posted.map((p) => p.content).join("\n")).toContain(
      "Run `/connect provider:github`",
    );
  });
});
