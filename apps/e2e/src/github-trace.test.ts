import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A Worker asks `user_token` for GitHub; the Coordinator checks what that token can reach and
// leaves a `system` event on the ticket. GitHub answers 404 for a repo the token cannot see, so
// the event is how an operator tells a missing app installation from a wrong account. When the
// Watcher's session ends it leaves its own event with the exit code and the agent's last words.

const CHANNEL = "chan-1";
const ada = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };

let SECRET: string;
let WORKER_ID: string;
let stack: Stack;
let github: ReturnType<typeof Bun.serve>;
let githubCalls: Array<{ path: string; authorization: string | null }>;

beforeEach(async () => {
  githubCalls = [];
  github = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      githubCalls.push({ path, authorization: req.headers.get("authorization") });
      const headers = { "x-github-request-id": `req-${githubCalls.length}` };
      if (path === "/user") return Response.json({ login: "ada-gh" }, { headers });
      if (path === "/user/installations") {
        return Response.json(
          { installations: [{ account: { login: "ada-gh" }, repository_selection: "selected" }] },
          { headers },
        );
      }
      return Response.json({ message: "Not Found" }, { status: 404, headers });
    },
  });
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    connections: true,
    githubApi: `http://localhost:${github.port}`,
  });
  ({ secret: SECRET, workerId: WORKER_ID } = await stack.registerSharedWorker());
  await stack.linkChannel(CHANNEL);
});
afterEach(async () => {
  await stack.stop();
  await github.stop(true);
});

const slash = (name: string, options: Record<string, string> = {}) =>
  forwardCommand(stack.coordinator, fakeCommand(ada, name, options)!, fetch);

const connectGithub = async () => {
  const reply = await slash("connect", { provider: "github" });
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  await browse(link);
  await browse(link, undefined, "POST");
};

const newTicket = async () => {
  await forwardInbound(stack.coordinator, fakeInbound(ada, "open a PR for the login fix")!, fetch);
  const [project] = await stack.json("GET", "/projects");
  return (await stack.json("GET", `/projects/${project.id}/tickets`))[0].id as string;
};

const worker = async () => {
  const mcp = await stack.worker(SECRET);
  return async (name: string, args: Record<string, unknown>) =>
    (await mcp.callTool({ name, arguments: args })) as any;
};

const systemEvents = async (ticketId: string) => {
  const tool = await worker();
  const { structuredContent } = await tool("ticket_get", { ticketId });
  return (structuredContent.events as Array<{ type: string; body: string; payload: any }>).filter(
    (e) => e.type === "system",
  );
};

describe("GitHub access trace", () => {
  it("records which repos the requester's token can see, and never the token", async () => {
    await slash("source-add", { link: "acme/web" });
    await connectGithub();
    const ticketId = await newTicket();
    const tool = await worker();

    const res = await tool("user_token", { ticketId, provider: "github" });
    expect(res.isError).toBeFalsy();
    const token = res.structuredContent.accessToken as string;

    const [event] = await systemEvents(ticketId);
    expect(event!.body).toBe(
      "GitHub access check as ada-gh: acme/web 404. App installations: ada-gh (selected).",
    );
    expect(event!.payload).toMatchObject({
      kind: "github_probe",
      login: "ada-gh",
      user: { status: 200 },
      installations: { status: 200, accounts: [{ account: "ada-gh", selection: "selected" }] },
      repos: [{ repo: "acme/web", status: 404, requestId: expect.stringMatching(/^req-/) }],
    });
    expect(githubCalls.map((c) => c.path).sort()).toEqual([
      "/repos/acme/web",
      "/user",
      "/user/installations",
    ]);
    expect(githubCalls.every((c) => c.authorization === `Bearer ${token}`)).toBe(true);
    expect(JSON.stringify(event)).not.toContain(token);
  });

  it("still hands out the token when GitHub is unreachable", async () => {
    await github.stop(true);
    await connectGithub();
    const ticketId = await newTicket();
    const tool = await worker();

    const res = await tool("user_token", { ticketId, provider: "github" });
    expect(res.isError).toBeFalsy();
    const [event] = await systemEvents(ticketId);
    expect(event!.payload).toMatchObject({
      kind: "github_probe",
      login: null,
      user: { status: 0 },
    });
  });
});

describe("Watcher session trace", () => {
  it("leaves the exit code and the agent's last output on the ticket", async () => {
    const ticketId = await newTicket();
    const watcher = createWatcher({
      config: {
        mcpUrl: `${stack.url}/mcp`,
        workerId: WORKER_ID,
        workerType: "local",
        agent: "claude",
        intervalMs: 1000,
        maxSessions: 1,
        cwd: ".",
        secret: SECRET,
      },
      client: {
        callTool: async (name, args) => (await (await worker())(name, args)).structuredContent,
      },
      spawner: {
        spawn: async (onOutput) => {
          onOutput?.("Blocked: the linked GitHub account still receives 404\n");
          return 0;
        },
      },
      log: () => {},
    });
    await watcher.pollOnce();
    await new Promise((r) => setTimeout(r, 200));

    const events = await systemEvents(ticketId);
    expect(events.map((e) => e.payload.kind)).toContain("watcher_session");
    const session = events.find((e) => e.payload.kind === "watcher_session")!;
    expect(session.payload).toMatchObject({ exitCode: 0 });
    expect(session.payload.tail).toContain("Blocked: the linked GitHub account");
  });
});
