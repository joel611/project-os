import { ndJsonStream } from "@agentclientprotocol/sdk";
import { IntentClassifier } from "@project-os/core";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import {
  createPiAcpAgent,
  type PiEvent,
  type PiSessionOptions,
} from "../../../packages/pi-acp/src/index.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { silentLogger } from "../../watcher/src/logger.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import type { RunLogIo } from "../../watcher/src/run-log.ts";
import { bunSpawner, type SpawnAcp } from "../../watcher/src/spawn.ts";
import { type Stack, startStack } from "./stack.ts";

// Pi runs through ACP when the Watcher is told to (WATCHER_PI_ACP): the Watcher speaks ACP to the
// pi-acp agent, hands it the Coordinator as an MCP server in `session/new`, and the session's
// updates become the ticket's run log. Pi itself is played by a fake session; the ACP framing
// between the two halves is real.

const CHANNEL = "chan-1";
const ada: FakeSpeaker = { channelId: CHANNEL, userId: "u-ada", name: "Ada" };

const classifier = Layer.succeed(IntentClassifier, {
  classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
});

let stack: Stack;
afterEach(() => stack.stop());

describe("Pi over ACP", () => {
  it("passes the Coordinator to Pi as an MCP server and records the session as a run", async () => {
    stack = await startStack({ classifier, sharedWorkerMaxTickets: 2 });
    const device = await stack.registerSharedWorker();
    await stack.linkChannel(CHANNEL);
    const inbound = fakeInbound(ada, "please add dark mode");
    await forwardInbound(stack.coordinator, inbound!, fetch);
    const [project] = await stack.json("GET", "/projects");
    const [ticket] = (await stack.json("GET", `/projects/${project.id}/tickets`)) as Array<{
      id: string;
      projectId: string;
    }>;

    const opened: PiSessionOptions[] = [];
    const prompts: string[] = [];
    const piAgent = createPiAcpAgent({
      createSession: async (options) => {
        opened.push(options);
        const listeners = new Set<(event: PiEvent) => void>();
        const emit = (event: PiEvent) => listeners.forEach((listener) => listener(event));
        return {
          prompt: async (text) => {
            prompts.push(text);
            emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "Claiming " },
            });
            emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "the ticket." },
            });
            emit({
              type: "tool_execution_start",
              toolCallId: "c1",
              toolName: "mcp__project-os__ticket_claim",
              args: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
            });
            emit({
              type: "tool_execution_end",
              toolCallId: "c1",
              toolName: "mcp__project-os__ticket_claim",
              result: { content: [{ type: "text", text: `claimed with ${device.secret}` }] },
              isError: false,
            });
          },
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          abort: async () => {},
          dispose: () => {},
        };
      },
    });

    const spawnAcp: SpawnAcp = () => {
      const toAgent = new TransformStream<Uint8Array>();
      const fromAgent = new TransformStream<Uint8Array>();
      const connection = piAgent.connect(ndJsonStream(fromAgent.writable, toAgent.readable));
      return {
        exited: connection.closed.then(() => 0),
        stdin: toAgent.writable,
        stdout: fromAgent.readable,
        stderr: new Response("pi warning\n").body,
        kill: () => connection.close(),
      };
    };

    const config = loadConfig(
      {
        server: stack.url,
        workerId: device.workerId,
        name: "box",
        secret: device.secret,
        agent: "pi",
      },
      () => true,
    );
    expect(config.piAcp).toBe(false);
    const spool = new Map<string, string>();
    const runLog: RunLogIo = {
      post: async (url, secret, upload) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify(upload),
        });
        const body = (await res.json()) as { nextSeq?: number };
        return res.ok
          ? { ok: true, nextSeq: body.nextSeq ?? upload.seq + 1 }
          : { ok: false, status: res.status };
      },
      spool: {
        write: (name, contents) => void spool.set(name, contents),
        list: () => [...spool].map(([name, contents]) => ({ name, contents })),
        remove: (name) => void spool.delete(name),
      },
      flushEveryMs: 60_000,
      sleep: async () => {},
    };
    const spawner = bunSpawner(
      { ...config, piAcp: true, piAcpCommand: ["pi-acp"] },
      () => {
        throw new Error("Pi should run through ACP, not as a CLI");
      },
      {
        readFile: () => undefined,
        writePrivate: () => {
          throw new Error("no MCP config file should be written for Pi over ACP");
        },
        spawnAcp,
        env: {},
        configDir: "/cfg",
        home: "/home/me",
        mcp: httpMcpClient(config.mcpUrl, fetch, config.secret),
        workspaces: stack.workspaces(),
        sessions: stack.sessions(),
        runLog,
        logger: silentLogger,
      },
    );

    expect(await spawner.spawn(ticket!)).toBe(0);

    // The Coordinator reached Pi in session/new, with the device's Bearer.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.mcpServers["project-os"]).toEqual({
      url: `${stack.url}/mcp`,
      headers: { Authorization: `Bearer ${device.secret}` },
      exposure: "direct",
    });
    expect(prompts[0]).toContain(`Your worker_id is \`${device.workerId}\`.`);

    const { runs } = (await stack.json("GET", `/tickets/${ticket!.id}/runs`)) as {
      runs: Array<Record<string, any>>;
    };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: "pi", status: "succeeded", exitCode: 0, errorCount: 0 });
    const { events } = (await stack.json("GET", `/tickets/${ticket!.id}/runs/${runs[0]!.id}`)) as {
      events: Array<{ type: string; text: string; tool?: string }>;
    };
    // Pi's stderr is kept too, marked as such.
    expect(events.find((e) => e.tool === "stderr")?.text).toBe("pi warning");
    expect(events.filter((e) => e.tool !== "stderr").map((e) => e.type)).toEqual([
      "lifecycle",
      "message",
      "tool_call",
      "tool_result",
      "lifecycle",
    ]);
    const steps = events.filter((e) => e.tool !== "stderr");
    expect(steps[1]!.text).toBe("Claiming the ticket.");
    expect(steps[2]).toMatchObject({ tool: "mcp__project-os__ticket_claim" });
    expect(steps[3]).toMatchObject({ tool: "mcp__project-os__ticket_claim" });
    // Secrets are masked in storage, as for every other agent.
    const stored = JSON.stringify(events);
    expect(stored).not.toContain(device.secret);
    expect(stored).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
