import { makeSandboxLauncher, type SandboxRunner } from "@project-os/sandbox-core";
import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import {
  fakeCommand,
  fakeInbound,
  type FakeSpeaker,
} from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import type { WatcherCredentials } from "../../watcher/src/credentials.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import type { RunLogIo } from "../../watcher/src/run-log.ts";
import { resendSpooled } from "../../watcher/src/run-log.ts";
import { bunSpawner, type SpawnProcess } from "../../watcher/src/spawn.ts";
import { silentLogger } from "../../watcher/src/logger.ts";
import { browse } from "./browse.ts";
import { type Stack, startStack } from "./stack.ts";

// A Worker's session becomes a run on its ticket. On a registered computer the Watcher pipes the
// agent's output, masks secrets, and uploads it in chunks to POST /tickets/:id/runs with the
// device's Bearer; a sandbox session's output is kept by the launcher's end-of-session hook. The
// dashboard reads the runs back: an Operator sees every ticket's, a member only the tickets they
// asked for. The agent (Claude Code) is played by a fake process printing its stream-json.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };
const bob: FakeSpeaker = { channelId: CHANNEL, userId: "u-bob", name: "Bob" };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
afterEach(() => stack.stop());

const say = async (who: FakeSpeaker, content: string) => {
  const inbound = fakeInbound(who, content);
  if (!inbound) throw new Error("message was dropped");
  await forwardInbound(stack.coordinator, inbound, fetch);
};

const ticketIds = async () => {
  const [project] = await stack.json("GET", "/projects");
  const all = (await stack.json("GET", `/projects/${project.id}/tickets`)) as Array<{
    id: string;
    title: string;
  }>;
  return {
    ada: all.find((t) => t.title === "please add dark mode")!.id,
    bob: all.find((t) => t.title === "fix the login bug")?.id as string,
  };
};

const jsonLines = (...messages: unknown[]) =>
  messages.map((m) => JSON.stringify(m)).join("\n") + "\n";

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

/** What Claude Code prints with `--output-format stream-json`, with two secrets in it. */
const claudeOutput = (deviceSecret: string) =>
  jsonLines(
    { type: "system", subtype: "init", model: "claude-test", tools: ["a", "b"] },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Claiming the ticket, then reading the login page." },
          {
            type: "tool_use",
            id: "tu1",
            name: "mcp__project-os__ticket_claim",
            input: { ticketId: "t", token: GITHUB_TOKEN },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: `claimed (Authorization: Bearer ${deviceSecret})`,
          },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 4200,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  );

/** Runs one Watcher session for `ticketId` the way `main.bun.ts` wires it, against the real stack. */
const watcherSession = async (
  device: { workerId: string; secret: string },
  ticketId: string,
  options: { stdout: string; exitCode?: number; reachable?: () => boolean } = { stdout: "" },
) => {
  const credentials: WatcherCredentials = {
    server: stack.url,
    workerId: device.workerId,
    name: "shared-box",
    secret: device.secret,
  };
  const config = loadConfig(credentials, () => true);
  const spool = new Map<string, string>();
  const runLog: RunLogIo = {
    post: async (url, secret, upload) => {
      if (options.reachable && !options.reachable()) throw new Error("offline");
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(upload),
      });
      const body = (await res.json().catch(() => ({}))) as { nextSeq?: number; expected?: number };
      return res.ok
        ? { ok: true, nextSeq: body.nextSeq ?? upload.seq + 1 }
        : {
            ok: false,
            status: res.status,
            ...(body.expected !== undefined && { expected: body.expected }),
          };
    },
    spool: {
      write: (name, contents) => void spool.set(name, contents),
      list: () => [...spool].map(([name, contents]) => ({ name, contents })),
      remove: (name) => void spool.delete(name),
    },
    newRunId: () => crypto.randomUUID(),
    now: () => new Date(),
    secrets: [],
    flushEveryMs: 60_000,
    sleep: async () => {},
  };
  const shown: string[] = [];
  const spawnProcess: SpawnProcess = (cmd) => {
    shown.push(cmd.join(" "));
    return {
      exited: Promise.resolve(options.exitCode ?? 0),
      stdout: new Response(options.stdout).body,
      stderr: new Response("npm warn something\n").body,
    };
  };
  const spawner = bunSpawner(config, spawnProcess, {
    readFile: () => undefined,
    writePrivate: () => {},
    env: {},
    configDir: "/cfg",
    home: "/home/me",
    runLog,
    logger: silentLogger,
    terminal: { out: (t) => void shown.push(t), err: (t) => void shown.push(t) },
  });
  const exit = await spawner.spawn(ticketId);
  return { exit, shown, spool, runLog, config };
};

const operatorRuns = async (ticketId: string) =>
  (await stack.json("GET", `/tickets/${ticketId}/runs`)) as { runs: Array<Record<string, any>> };

const transcript = async (ticketId: string, runId: string) =>
  (await stack.json("GET", `/tickets/${ticketId}/runs/${runId}`)) as {
    run: Record<string, any>;
    events: Array<{ type: string; text: string; tool?: string }>;
  };

describe("run logs", () => {
  it("ships a Watcher session to the ticket with secrets masked, and shows it to admins", async () => {
    stack = await startStack({ classifier, sharedWorkerMaxTickets: 2 });
    const device = await stack.registerSharedWorker();
    await stack.linkChannel(CHANNEL);
    await say(ada, "please add dark mode");
    const { ada: adaTicket } = await ticketIds();

    const { exit, shown } = await watcherSession(device, adaTicket, {
      stdout: claudeOutput(device.secret),
    });
    expect(exit).toBe(0);
    // The agent was asked for its structured stream, and the terminal still reads like text.
    expect(shown[0]).toContain("--output-format stream-json");
    expect(shown.join("")).toContain("Claiming the ticket, then reading the login page.");

    const { runs } = await operatorRuns(adaTicket);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      ticketId: adaTicket,
      workerId: device.workerId,
      agent: "claude",
      status: "succeeded",
      exitCode: 0,
      errorCount: 0,
      expired: false,
    });

    const { events } = await transcript(adaTicket, runs[0]!.id);
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("lifecycle");
    expect(kinds).toContain("message");
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      tool: "mcp__project-os__ticket_claim",
    });
    expect(events.find((e) => e.type === "tool_result")?.tool).toBe(
      "mcp__project-os__ticket_claim",
    );
    // stderr is kept too, marked as such.
    expect(events.find((e) => e.tool === "stderr")?.text).toBe("npm warn something");

    // Neither the device secret nor the GitHub token reached storage.
    const stored = JSON.stringify(events);
    expect(stored).not.toContain(device.secret);
    expect(stored).not.toContain(GITHUB_TOKEN);
    expect(stored).toContain("[REDACTED]");

    // The audit log says when it started and how it ended.
    const audit = (await stack.json("GET", "/audit?kind=ticket")) as { entries: Array<any> };
    expect(
      audit.entries
        .filter((e) => e.action.startsWith("run_"))
        .map((e) => e.action)
        .sort(),
    ).toEqual(["run_finished", "run_started"]);
  });

  it("marks a failed session and keeps what it printed", async () => {
    stack = await startStack({ classifier, sharedWorkerMaxTickets: 2 });
    const device = await stack.registerSharedWorker();
    await stack.linkChannel(CHANNEL);
    await say(ada, "please add dark mode");
    const { ada: adaTicket } = await ticketIds();

    await watcherSession(device, adaTicket, { stdout: "plain line from pi\n", exitCode: 2 });

    const { runs } = await operatorRuns(adaTicket);
    expect(runs[0]).toMatchObject({ status: "failed", exitCode: 2, errorCount: 1 });
    const { events } = await transcript(adaTicket, runs[0]!.id);
    expect(events.map((e) => e.text)).toContain("plain line from pi");
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("saves a session's log while the Coordinator is unreachable and sends it later", async () => {
    stack = await startStack({ classifier, sharedWorkerMaxTickets: 2 });
    const device = await stack.registerSharedWorker();
    await stack.linkChannel(CHANNEL);
    await say(ada, "please add dark mode");
    const { ada: adaTicket } = await ticketIds();

    let online = false;
    const offline = await watcherSession(device, adaTicket, {
      stdout: claudeOutput(device.secret),
      reachable: () => online,
    });
    expect(offline.spool.size).toBe(1);
    expect((await operatorRuns(adaTicket)).runs).toEqual([]);

    online = true;
    expect(await resendSpooled(offline.runLog, device.secret)).toBe(1);
    expect(offline.spool.size).toBe(0);
    const { runs } = await operatorRuns(adaTicket);
    expect(runs[0]).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect((await transcript(adaTicket, runs[0]!.id)).events.length).toBeGreaterThan(3);
  });

  it("takes uploads only from the ticket's own worker, in order", async () => {
    stack = await startStack({ classifier, sharedWorkerMaxTickets: 2 });
    const device = await stack.registerSharedWorker("box-1");
    const other = await stack.registerSharedWorker("box-2");
    await stack.linkChannel(CHANNEL);
    await say(ada, "please add dark mode");
    const { ada: adaTicket } = await ticketIds();

    const upload = (token: string | undefined, body: unknown) =>
      fetch(`${stack.url}/tickets/${adaTicket}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    const chunk = (seq: number, runId = "run-aaaaaaaa") => ({
      runId,
      seq,
      agent: "claude",
      events: [{ at: new Date().toISOString(), type: "output", text: `line ${seq}` }],
    });

    expect((await upload(undefined, chunk(0))).status).toBe(401);
    // box-2 holds no claim on this ticket (whichever box got it, one of the two is not it).
    const holder = (await stack.json("GET", `/tickets/${adaTicket}`)).ticket.workerId;
    const stranger = holder === device.workerId ? other : device;
    const owner = holder === device.workerId ? device : other;
    expect((await upload(stranger.secret, chunk(0))).status).toBe(403);

    expect((await upload(owner.secret, { nope: true })).status).toBe(400);
    expect((await upload(owner.secret, chunk(3))).status).toBe(409);
    const gap = await (await upload(owner.secret, chunk(3))).json();
    expect(gap).toEqual({ error: "RunOutOfOrder", expected: 0 });

    expect(await (await upload(owner.secret, chunk(0))).json()).toMatchObject({ nextSeq: 1 });
    // The same chunk again (a lost answer) is stored once.
    expect(await (await upload(owner.secret, chunk(0))).json()).toMatchObject({ nextSeq: 1 });
    expect(await (await upload(owner.secret, chunk(1))).json()).toMatchObject({ nextSeq: 2 });
    const { runs } = await operatorRuns(adaTicket);
    expect(runs[0]).toMatchObject({ eventCount: 2, status: "running" });
  });

  it("keeps a sandbox session's output as a run, masking the session's own tokens", async () => {
    let record: ((s: Parameters<Stack["recordSandboxRun"]>[0]) => Promise<void>) | undefined;
    const runner: SandboxRunner = {
      run: async ({ env }) => ({
        exitCode: 1,
        output: [
          "npm WARN deprecated something",
          `pi: calling the model with ${env.OPENROUTER_API_KEY}`,
          `mcp ${JSON.parse(env.PROJECT_OS_MCP_JSON!).mcpServers["project-os"].headers.Authorization}`,
          "Error: build failed",
        ].join("\n"),
      }),
    };
    stack = await startStack({
      classifier,
      workerLauncher: makeSandboxLauncher({
        providers: [{ workerType: "daytona_pi", runner }],
        mcpUrl: "https://tunnel.example/mcp",
        openrouterApiKey: "openrouter-key-0123456789",
        model: "openrouter/m",
        log: () => {},
        onSessionEnd: (session) => record!(session),
      }),
    });
    record = (session) => stack.recordSandboxRun(session);
    await stack.linkChannel(CHANNEL);
    await say(ada, "please add dark mode");
    const { ada: adaTicket } = await ticketIds();

    await expect
      .poll(async () => (await operatorRuns(adaTicket)).runs.length, { timeout: 5_000 })
      .toBe(1);
    const { runs } = await operatorRuns(adaTicket);
    expect(runs[0]).toMatchObject({
      agent: "pi",
      model: "openrouter/m",
      status: "failed",
      exitCode: 1,
    });
    const { events } = await transcript(adaTicket, runs[0]!.id);
    expect(events.map((e) => e.text)).toContain("Error: build failed");
    const stored = JSON.stringify(events);
    expect(stored).not.toContain("openrouter-key-0123456789");
    expect(stored).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  it("shows a member only the runs of tickets they asked for", async () => {
    stack = await startStack({ classifier, connections: true, sharedWorkerMaxTickets: 2 });
    const device = await stack.registerSharedWorker();
    await stack.linkChannel(CHANNEL);
    await say(ada, "please add dark mode");
    await say(bob, "fix the login bug");
    const ids = await ticketIds();
    await watcherSession(device, ids.ada, { stdout: claudeOutput(device.secret) });
    await watcherSession(device, ids.bob, { stdout: "bob's run\n" });

    const linked = await forwardCommand(
      stack.coordinator,
      fakeCommand(ada, "dashboard", {})!,
      fetch,
    );
    const link = /(http:\/\/\S+\/connect\/\S+)/.exec(linked.content)![1]!;
    expect((await browse(link, undefined, "POST")).body).toContain("Google account connected");
    const landed = new URL((await browse(`${stack.url}/sign-in/google`)).url);
    const verified = await fetch(`${stack.url}/api/auth/one-time-token/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: landed.searchParams.get("ott") }),
    });
    const token = verified.headers.get("set-auth-token")!;
    const get = async (path: string) => {
      const res = await fetch(`${stack.url}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };

    const mine = await get(`/tickets/${ids.ada}/runs`);
    expect(mine.status).toBe(200);
    expect(mine.body.runs).toHaveLength(1);
    const one = await get(`/tickets/${ids.ada}/runs/${mine.body.runs[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.events.length).toBeGreaterThan(3);

    // Bob's ticket (and its run) is not Ada's.
    expect((await get(`/tickets/${ids.bob}/runs`)).status).toBe(404);
    const bobRun = (await operatorRuns(ids.bob)).runs[0]!.id;
    expect((await get(`/tickets/${ids.bob}/runs/${bobRun}`)).status).toBe(404);
    // A run id from another ticket does not read through Ada's own ticket either.
    expect((await get(`/tickets/${ids.ada}/runs/${bobRun}`)).status).toBe(404);
  });
});
