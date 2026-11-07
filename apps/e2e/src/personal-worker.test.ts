import { classifierReturning } from "@project-os/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand, fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { parseArgs } from "../../watcher/src/cli.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import type { WatcherCredentials } from "../../watcher/src/credentials.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { registerDevice } from "../../watcher/src/register.ts";
import { type Stack, startStack } from "./stack.ts";

// /register-worker in Discord -> Coordinator /commands -> one-time code in a private reply ->
// the Watcher on Ada's computer runs the command line from that reply: POST /workers/register
// -> device credentials -> polls /mcp with its Bearer secret. Ada's tickets go to her device;
// everyone else's (and hers while it's offline) go to the shared cloud worker (Daytona, played
// by a recording launcher). The spawned Claude Code session is an SDK MCP client.

const CHANNEL = "chan-1";
const ada = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const bob = { channelId: CHANNEL, userId: "u-bob", name: "Bob" };

let stack: Stack;
let launched: Array<{ ticketId: string; workerType: string; workerId: string }>;
beforeEach(async () => {
  launched = [];
  stack = await startStack({
    classifier: classifierReturning("new_request"),
    workerId: "shared-1",
    defaultWorkerType: "daytona_pi",
    workerLauncher: {
      pool: Effect.succeed([{ workerType: "daytona_pi" }]),
      launch: (input) => Effect.sync(() => void launched.push(input)),
    },
  });
  await stack.linkChannel(CHANNEL);
});
afterEach(() => stack.stop());

const slash = (speaker: typeof ada, name: string, options: Record<string, string> = {}) =>
  forwardCommand(stack.url, fakeCommand(speaker, name, options)!, fetch);

const say = (speaker: typeof ada, content: string) =>
  forwardInbound(stack.url, fakeInbound(speaker, content)!, fetch);

/** Runs what the /register-worker reply says to paste, minus the install. */
const registerFromReply = async (content: string): Promise<WatcherCredentials> => {
  const line = /```sh\n(.+)\n```/.exec(content)![1]!;
  const argv = line.split(" && ")[1]!.split(" ").slice(1); // drop `project-os-watcher`
  const command = parseArgs(argv);
  if (command.kind !== "register") throw new Error(command.kind);
  return registerDevice(
    { server: command.server!, token: command.token, hostname: "ada-mbp" },
    fetch,
  );
};

const ADA_ASK = "fix the login page";
const BOB_ASK = "write release notes";

/** The project's tickets: Ada's first, then Bob's (whichever exist). */
const tickets = async () => {
  const [project] = await stack.json("GET", "/projects");
  const all = (await stack.json("GET", `/projects/${project.id}/tickets`)) as any[];
  const asked = (text: string) => all.find((t) => t.inputSummary.includes(text));
  return [asked(ADA_ASK), asked(BOB_ASK)].filter(Boolean);
};

/** Plays session-start.md as Claude Code would, with the MCP config the Watcher wrote. */
const claudeSession = async (workerId: string, secret: string) => {
  const mcp = await stack.worker(secret);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as any;
    expect(res.isError, `${name} failed: ${JSON.stringify(res.content)}`).toBeFalsy();
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
    body: "done on Ada's laptop",
  });
  await tool("ticket_update_status", { ticketId, status: "completed" });
  return 0;
};

describe("personal worker", () => {
  it("registers Ada's computer from /register-worker and works only her tickets there", async () => {
    const reply = await slash(ada, "register-worker");
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain(
      "bun install -g @project-os/watcher && project-os-watcher register",
    );
    expect(reply.content).toContain(`--server ${stack.url}`);

    const credentials = await registerFromReply(reply.content);
    expect(credentials).toMatchObject({ server: stack.url, name: "ada-mbp" });

    // The code worked once.
    await expect(registerFromReply(reply.content)).rejects.toThrow(/already used/);

    const config = loadConfig(credentials);
    const sessions: Promise<number>[] = [];
    const watcher = createWatcher({
      config,
      client: httpMcpClient(config.mcpUrl, fetch, config.secret),
      spawner: {
        spawn: () => {
          const s = claudeSession(config.workerId, config.secret!);
          sessions.push(s);
          return s;
        },
      },
      log: () => {},
    });
    await watcher.pollOnce(); // first heartbeat: now online, nothing to do yet
    expect(sessions).toEqual([]);
    expect((await slash(ada, "workers")).content).toContain("**ada-mbp**");
    expect((await slash(ada, "workers")).content).toContain("online");

    await say(ada, ADA_ASK);
    await say(bob, BOB_ASK);
    const [adaTicket, bobTicket] = await tickets();
    expect(adaTicket).toMatchObject({ workerType: "local_claude", workerId: config.workerId });
    expect(bobTicket).toMatchObject({
      workerType: "daytona_pi",
      workerId: `sandbox-daytona-${bobTicket.id}`,
    });
    expect(launched.map((l) => l.workerType)).toEqual(["local_claude", "daytona_pi"]);

    await watcher.pollOnce();
    await Promise.all(sessions);
    expect(sessions).toHaveLength(1);
    const [adaDone, bobStill] = await tickets();
    expect(adaDone.status).toBe("completed");
    expect(bobStill.status).toBe("assigned");
    expect(stack.posted.at(-1)!.content).toContain("done on Ada's laptop");
  });

  it("keeps Ada's device and tickets from anyone without its secret", async () => {
    const credentials = await registerFromReply((await slash(ada, "register-worker")).content);
    const own = httpMcpClient(`${stack.url}/mcp`, fetch, credentials.secret);
    await own.callTool("worker_heartbeat", {
      workerId: credentials.workerId,
      workerType: "local_claude",
    });
    await say(ada, ADA_ASK);
    const [ticket] = await tickets();

    const anon = httpMcpClient(`${stack.url}/mcp`, fetch);
    await expect(
      anon.callTool("ticket_list_assigned", { workerId: credentials.workerId }),
    ).rejects.toThrow(/WorkerUnauthorized/);
    await expect(
      anon.callTool("ticket_claim", { ticketId: ticket.id, workerId: "shared-1" }),
    ).rejects.toThrow(/WorkerUnauthorized/);
    await expect(
      anon.callTool("user_token", { ticketId: ticket.id, provider: "github" }),
    ).rejects.toThrow(/WorkerUnauthorized/);

    const forged = httpMcpClient(`${stack.url}/mcp`, fetch, "not-a-secret");
    await expect(forged.callTool("ticket_list_assigned", { workerId: "x" })).rejects.toThrow(
      /HTTP 401/,
    );

    // A personal device can't reach past its own tickets.
    await say(bob, BOB_ASK);
    const [, bobTicket] = await tickets();
    await expect(own.callTool("ticket_get", { ticketId: bobTicket.id })).rejects.toThrow(
      /WorkerUnauthorized/,
    );
  });

  it("sends Ada's tickets to the shared cloud worker while her device is offline, and after removal", async () => {
    const credentials = await registerFromReply((await slash(ada, "register-worker")).content);
    // Registered but never heartbeat: offline.
    await say(ada, ADA_ASK);
    const [offline] = await tickets();
    expect(offline).toMatchObject({ workerType: "daytona_pi" });
    expect((await slash(ada, "workers")).content).toContain("offline, last seen never");

    expect(
      (await slash(ada, "unregister-worker", { worker: credentials.workerId })).content,
    ).toContain("Removed ada-mbp");
    const removed = httpMcpClient(`${stack.url}/mcp`, fetch, credentials.secret);
    await expect(removed.callTool("ticket_list_assigned", { workerId: "x" })).rejects.toThrow(
      /HTTP 401/,
    );
  });
});
