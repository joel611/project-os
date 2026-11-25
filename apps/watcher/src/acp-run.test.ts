import {
  agent,
  methods,
  ndJsonStream,
  RequestError,
  type AgentApp,
  type AgentContext,
  type PermissionOption,
} from "@agentclientprotocol/sdk";
import type { RunEvent } from "@project-os/contracts";
import { describe, expect, it } from "vite-plus/test";
import { type AcpProcess, runAcpSession } from "./acp-run.ts";

/** An ACP agent `app` on the far end of in-memory pipes, as a process the Watcher can drive. */
const processFor = (app: AgentApp): AcpProcess & { killed: () => boolean } => {
  const toAgent = new TransformStream<Uint8Array>();
  const fromAgent = new TransformStream<Uint8Array>();
  const connection = app.connect(ndJsonStream(fromAgent.writable, toAgent.readable));
  let killed = false;
  return {
    exited: connection.closed.then(() => 0),
    stdin: toAgent.writable,
    stdout: fromAgent.readable,
    kill: () => {
      killed = true;
      connection.close();
    },
    killed: () => killed,
  };
};

const initialize = (http: boolean, named = true) => ({
  protocolVersion: 1,
  agentCapabilities: { mcpCapabilities: { http, sse: false } },
  ...(named && { agentInfo: { name: "fake-pi", version: "1" } }),
});

const run = async (app: AgentApp, crashOnExit = false) => {
  const events: RunEvent[] = [];
  const base = processFor(app);
  const process = crashOnExit
    ? { ...base, exited: base.exited.then(() => Promise.reject(new Error("gone"))) }
    : base;
  process.exited.catch(() => undefined);
  const exit = await runAcpSession({
    process,
    cwd: "/work",
    prompt: "go",
    mcpUrl: "http://coord/mcp",
    secret: "s3cret",
    now: () => "t",
    onEvent: (event) => events.push(event),
  });
  return { exit, events, killed: base.killed() };
};

describe("runAcpSession", () => {
  it("passes the Coordinator in session/new and records the turn", async () => {
    let seen: unknown;
    const app = agent()
      .onRequest(methods.agent.initialize, () => initialize(true))
      .onRequest(methods.agent.session.new, ({ params }) => {
        seen = params;
        return { sessionId: "s1" };
      })
      .onRequest(methods.agent.session.prompt, async ({ client }) => {
        await client.notify(methods.client.session.update, {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        });
        return { stopReason: "end_turn" };
      });
    const { exit, events, killed } = await run(app);
    expect(exit).toBe(0);
    expect(killed).toBe(true);
    expect(seen).toEqual({
      cwd: "/work",
      mcpServers: [
        {
          type: "http",
          name: "project-os",
          url: "http://coord/mcp",
          headers: [{ name: "Authorization", value: "Bearer s3cret" }],
        },
      ],
    });
    expect(events.map((e) => [e.type, e.text])).toEqual([
      ["lifecycle", "Session started (fake-pi over ACP)."],
      ["message", "hi"],
      ["lifecycle", "Session finished (end_turn)."],
    ]);
  });

  it("answers a permission request the agent makes anyway, allowing once if it can", async () => {
    const outcomes: unknown[] = [];
    const ask = async (client: AgentContext, options: PermissionOption[]) =>
      outcomes.push(
        await client.request(methods.client.session.requestPermission, {
          sessionId: "s1",
          toolCall: { toolCallId: "c1" },
          options,
        }),
      );
    const app = agent()
      .onRequest(methods.agent.initialize, () => initialize(true))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "s1" }))
      .onRequest(methods.agent.session.prompt, async ({ client }) => {
        await ask(client, [
          { optionId: "no", name: "No", kind: "reject_once" },
          { optionId: "yes", name: "Yes", kind: "allow_once" },
        ]);
        await ask(client, [{ optionId: "no", name: "No", kind: "reject_once" }]);
        return { stopReason: "end_turn" };
      });
    expect((await run(app)).exit).toBe(0);
    expect(outcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "yes" } },
      { outcome: { outcome: "cancelled" } },
    ]);
  });

  it("fails when the agent cannot use HTTP MCP servers", async () => {
    const app = agent().onRequest(methods.agent.initialize, () => initialize(false));
    const { exit, events } = await run(app);
    expect(exit).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1)!.text).toContain("cannot use HTTP MCP servers");
  });

  it("fails when the turn does not end normally", async () => {
    const app = agent()
      .onRequest(methods.agent.initialize, () => initialize(true))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "s1" }))
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: "cancelled" }));
    const { exit, events } = await run(app);
    expect(exit).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", text: "Session finished (cancelled)." });
  });

  it("fails when the agent errors, keeping the message it had started", async () => {
    const app = agent()
      .onRequest(methods.agent.initialize, () => initialize(true))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "s1" }))
      .onRequest(methods.agent.session.prompt, async ({ client }) => {
        await client.notify(methods.client.session.update, {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "half" } },
        });
        throw RequestError.internalError(undefined, "model unavailable");
      });
    const { exit, events } = await run(app);
    expect(exit).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["lifecycle", "message", "error"]);
    expect(events.at(-1)!.text).toContain("model unavailable");
  });

  it("calls an agent that gave no name just an agent, and survives it exiting badly", async () => {
    const app = agent()
      .onRequest(methods.agent.initialize, () => initialize(true, false))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "s1" }))
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: "end_turn" }));
    const { exit, events } = await run(app, true);
    expect(exit).toBe(0);
    expect(events[0]!.text).toBe("Session started (agent over ACP).");
  });
});
