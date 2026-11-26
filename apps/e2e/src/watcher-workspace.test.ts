import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { collectLogger } from "../../watcher/src/logger.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { bunSpawner } from "../../watcher/src/spawn.ts";
import type { Git } from "../../watcher/src/workspace.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A project that links a GitHub repo: the Watcher (real poll loop, real MCP client, against the
// real Coordinator) reads the project's sources, clones the repo into the ticket's workspace, and
// starts the agent there. git stands in for GitHub; the agent CLI is faked.

const CHANNEL = "chan-1";
const ADA = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
let stack: Stack;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request"), connections: true });
});
afterEach(() => stack.stop());

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

/** Runs one poll of a Watcher for `device` and waits for the session it starts to end. */
const pollOnce = async (device: { workerId: string; secret: string }, git?: Git) => {
  const config = loadConfig({ server: stack.url, name: "box", ...device }, () => true);
  const client = httpMcpClient(config.mcpUrl, fetch, config.secret);
  const workspaces = stack.workspaces(git);
  const launched: Array<{ cwd: string; prompt: string }> = [];
  const logs: string[] = [];
  const watcher = createWatcher({
    config,
    client,
    spawner: bunSpawner(
      config,
      (cmd, options) => {
        launched.push({ cwd: options.cwd, prompt: cmd[2]! });
        return { exited: Promise.resolve(0) };
      },
      {
        readFile: () => undefined,
        writePrivate: () => {},
        env: { PATH: process.env.PATH },
        configDir: "/unused",
        home: "/unused",
        mcp: client,
        workspaces,
      },
    ),
    logger: collectLogger(logs),
  });
  await watcher.pollOnce();
  await expect.poll(() => logs.at(-1)).toBe("session exit code=0 (0/1)");
  return { launched, root: workspaces.root };
};

it("clones the project's repo into the ticket's workspace and starts the agent in it", async () => {
  const { device, ticketId } = await ticketWithRepo();
  const cloned: string[] = [];
  const github: Git = async (args) => {
    cloned.push(args.at(-2)!);
    mkdirSync(args.at(-1)!, { recursive: true });
    writeFileSync(join(args.at(-1)!, "README.md"), "acme/web");
    return { code: 0, stderr: "" };
  };

  const { launched, root } = await pollOnce(device, github);

  const checkout = join(root, ticketId, "web");
  expect(cloned).toEqual(["https://github.com/acme/web.git"]);
  expect(launched).toHaveLength(1);
  expect(launched[0]!.cwd).toBe(checkout);
  expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("acme/web");
  expect(launched[0]!.prompt).toContain(`- \`web\` (\`acme/web\`): \`${checkout}\``);
});

it("clones a private repo with the requester's own GitHub token, kept out of argv and the prompt", async () => {
  const { device, ticketId } = await ticketWithRepo();
  // Ada links GitHub with /connect; the fake provider issues "at-github-1".
  const reply = await forwardCommand(
    stack.coordinator,
    fakeCommand(ADA, "connect", { provider: "github" })!,
    fetch,
  );
  const link = /(http:\/\/\S+\/connect\/\S+)/.exec(reply.content)![1]!;
  await browse(link);
  await browse(link, undefined, "POST");

  const header = `AUTHORIZATION: basic ${btoa("x-access-token:at-github-1")}`;
  const argv: string[][] = [];
  const github: Git = async (args, { env }) => {
    argv.push([...args]);
    if (!Object.values(env).includes(header)) {
      return { code: 128, stderr: "fatal: could not read Username: terminal prompts disabled\n" };
    }
    mkdirSync(args.at(-1)!, { recursive: true });
    return { code: 0, stderr: "" };
  };

  const { launched, root } = await pollOnce(device, github);

  expect(argv).toHaveLength(2);
  expect(argv.flat().join(" ")).not.toContain("at-github-1");
  expect(launched[0]!.cwd).toBe(join(root, ticketId, "web"));
  expect(launched[0]!.prompt).not.toContain("at-github-1");
});

it("still starts the agent, in the ticket's folder, when the requester can't read the repo", async () => {
  const { device, ticketId } = await ticketWithRepo();
  // The stack's default git refuses every clone, and Ada has not connected GitHub.
  const { launched, root } = await pollOnce(device);

  expect(launched).toHaveLength(1);
  expect(launched[0]!.cwd).toBe(join(root, ticketId));
  expect(launched[0]!.prompt).toContain("could not be checked out");
  expect(launched[0]!.prompt).toMatch(/- `web` \(`acme\/web`\): .*no GitHub token.*NotConnected/);
});
