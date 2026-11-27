import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { fakeGithub } from "../../watcher/src/fake-github.ts";
import type { Git } from "../../watcher/src/git.ts";
import { collectLogger } from "../../watcher/src/logger.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { bunSpawner } from "../../watcher/src/spawn.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A project that links a GitHub repo: the Watcher (real poll loop, real MCP client, against the
// real Coordinator) reads the project's sources, checks the repo out as a worktree of a shared
// clone, starts the agent there, and removes the worktree once the ticket's PR is merged. Real
// git against bare repos stands in for GitHub; the agent CLI and GitHub's API are faked.

const CHANNEL = "chan-1";
const ADA = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const PR = "https://github.com/acme/web/pull/7";
let stack: Stack;
let gh: ReturnType<typeof fakeGithub>;
let pr: { merged: boolean; state: string };
beforeEach(async () => {
  pr = { merged: false, state: "open" };
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    connections: true,
    githubFetch: (async () => Response.json(pr)) as unknown as typeof fetch,
  });
  const dir = join(stack.dbPath, "..", "github");
  mkdirSync(dir);
  gh = fakeGithub(dir);
  await gh.push("acme/web", { "README.md": "acme/web" });
});
afterEach(async () => {
  gh.stop();
  await stack.stop();
});

/** A shared worker, a project linking `acme/web` as `web`, and one ticket from Ada. */
const ticketWithRepo = async () => {
  const device = await stack.registerSharedWorker();
  const projectId = await stack.linkChannel(CHANNEL);
  await stack.json("POST", `/projects/${projectId}/sources`, {
    type: "github_repo",
    externalId: "acme/web",
    name: "acme/web",
    alias: "web",
  });
  const inbound = fakeInbound(ADA, "fix the code");
  await forwardInbound(stack.coordinator, inbound!, fetch);
  const [ticket] = (await stack.json("GET", `/projects/${projectId}/tickets`)) as Array<{
    id: string;
  }>;
  return { device, ticketId: ticket!.id };
};

/** Ada links GitHub with /connect; the fake provider issues "at-github-1". */
const connectAda = async () => {
  const reply = await forwardCommand(
    stack.coordinator,
    fakeCommand(ADA, "connect", { provider: "github" })!,
    fetch,
  );
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  await browse(link);
  await browse(link, undefined, "POST");
};

/** A Watcher for `device`, wired as `main.bun.ts` wires it, with a fake agent CLI. */
const watcherFor = (device: { workerId: string; secret: string }, git?: Git) => {
  const config = loadConfig({ server: stack.url, name: "box", ...device }, () => true);
  const client = httpMcpClient(config.mcpUrl, fetch, config.secret);
  const workspaces = stack.workspaces(git);
  const sessions = stack.sessions();
  const launched: Array<{ cwd: string; prompt: string }> = [];
  const logs: string[] = [];
  const watcher = createWatcher({
    config,
    client,
    workspaces,
    spawner: bunSpawner(
      config,
      (cmd, options) => {
        launched.push({ cwd: options.cwd, prompt: cmd[2]! });
        return { exited: Promise.resolve(0), stdout: new Response("working\n").body };
      },
      {
        readFile: () => undefined,
        writePrivate: () => {},
        env: { PATH: process.env.PATH },
        configDir: "/unused",
        home: "/unused",
        mcp: client,
        workspaces,
        sessions,
      },
    ),
    logger: collectLogger(logs),
  });
  return {
    launched,
    logs,
    root: workspaces.root,
    sessionLogs: sessions.dir,
    /** One poll, then waits for the sessions it started to end. */
    poll: async () => {
      await watcher.pollOnce();
      // Real git under a loaded test run takes longer than `poll`'s one-second default.
      await expect.poll(() => watcher.running(), { timeout: 15_000 }).toBe(0);
    },
  };
};

it("checks the project's repo out as a worktree of a shared clone and starts the agent in it", async () => {
  const { device, ticketId } = await ticketWithRepo();
  const w = watcherFor(device, gh.git);
  await w.poll();

  const worktree = join(w.root, "tickets", ticketId, "web");
  expect(gh.calls.filter((c) => c.args[0] === "clone").map((c) => c.args.at(-2))).toEqual([
    "https://github.com/acme/web.git",
  ]);
  expect(existsSync(join(w.root, "repos", "acme", "web", ".git"))).toBe(true);
  expect(w.launched).toHaveLength(1);
  expect(w.launched[0]!.cwd).toBe(worktree);
  expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("acme/web");
  expect(await gh.sh(["branch", "--show-current"], worktree)).toBe(`ticket/${ticketId}`);
  expect(w.launched[0]!.prompt).toContain(
    `- \`web\` (\`acme/web\`): \`${worktree}\` on \`ticket/${ticketId}\``,
  );
});

it("checks out a private repo with the requester's own GitHub token, kept out of argv and the prompt", async () => {
  const { device, ticketId } = await ticketWithRepo();
  gh.restrict("acme/web", ["at-github-1"]);
  await connectAda();
  const w = watcherFor(device, gh.git);
  await w.poll();

  const clones = gh.calls.filter((c) => c.args[0] === "clone");
  expect(clones).toHaveLength(2);
  expect(gh.calls.flatMap((c) => c.args).join(" ")).not.toContain("at-github-1");
  expect(w.launched[0]!.cwd).toBe(join(w.root, "tickets", ticketId, "web"));
  expect(w.launched[0]!.prompt).not.toContain("at-github-1");
});

it("still starts the agent, in the ticket's folder, when the requester can't read the repo", async () => {
  const { device, ticketId } = await ticketWithRepo();
  // The stack's default git refuses every clone, and Ada has not connected GitHub.
  const w = watcherFor(device);
  await w.poll();

  expect(w.launched).toHaveLength(1);
  expect(w.launched[0]!.cwd).toBe(join(w.root, "tickets", ticketId));
  expect(w.launched[0]!.prompt).toContain("could not be checked out");
  expect(w.launched[0]!.prompt).toMatch(/- `web` \(`acme\/web`\): .*no GitHub token.*NotConnected/);
});

it("removes the ticket's worktree once the Coordinator sees its PR merged, keeping the clone", async () => {
  const { device, ticketId } = await ticketWithRepo();
  await connectAda();
  const w = watcherFor(device, gh.git);
  await w.poll();
  const ticketDir = join(w.root, "tickets", ticketId);
  const clone = join(w.root, "repos", "acme", "web");
  expect(existsSync(join(ticketDir, "web"))).toBe(true);

  // The agent's session, as the Worker prompt asks: claim, report the PR, complete.
  const tool = (name: string, args: Record<string, unknown>) =>
    device.mcp.callTool({ name, arguments: args });
  await tool("ticket_claim", { ticketId, workerId: device.workerId });
  await tool("ticket_append_event", { ticketId, type: "result", actor: "worker", body: PR });
  await tool("ticket_update_status", { ticketId, status: "completed" });

  // Open PR: the workspace stays.
  await stack.checkPullRequests();
  await w.poll();
  expect(existsSync(join(ticketDir, "web"))).toBe(true);

  pr = { merged: true, state: "closed" };
  await stack.checkPullRequests();
  await w.poll();
  expect(existsSync(ticketDir)).toBe(false);
  expect(existsSync(join(clone, ".git"))).toBe(true);
  expect(await gh.sh(["worktree", "list"], clone)).not.toContain(ticketId);
  expect(w.logs).toContain(`workspace: cleaned up ${ticketId}, its PRs are merged`);

  // The session's own log stays, with what the agent printed.
  const [file] = readdirSync(join(w.sessionLogs, ticketId));
  const events = readFileSync(join(w.sessionLogs, ticketId, file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { text: string });
  expect(events.map((e) => e.text)).toContain("working");
});
