import { client, methods, type McpServer, type SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vite-plus/test";
import { createPiAcpAgent } from "./agent.ts";
import type { PiEvent } from "./events.ts";
import type { PiRun, PiSessionOptions } from "./session.ts";

const fakePi = (script: (emit: (event: PiEvent) => void, text: string) => Promise<void>) => {
  const opened: PiSessionOptions[] = [];
  const state = { aborted: false, disposed: false, prompts: [] as string[] };
  const createSession = async (options: PiSessionOptions): Promise<PiRun> => {
    opened.push(options);
    const listeners = new Set<(event: PiEvent) => void>();
    return {
      prompt: async (text) => {
        state.prompts.push(text);
        await script((event) => listeners.forEach((l) => l(event)), text);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort: async () => {
        state.aborted = true;
      },
      dispose: () => {
        state.disposed = true;
      },
    };
  };
  return { createSession, opened, state };
};

const init = (cx: {
  request: (m: typeof methods.agent.initialize, p: { protocolVersion: number }) => Promise<unknown>;
}) => cx.request(methods.agent.initialize, { protocolVersion: 1 });

const drive = async (pi: ReturnType<typeof fakePi>, mcpServers: McpServer[]) => {
  const updates: SessionUpdate[] = [];
  const app = createPiAcpAgent({ createSession: pi.createSession });
  const result = await client({ name: "test" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    })
    .connectWith(app, async (cx) => {
      const init = await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      const session = await cx.request(methods.agent.session.new, { cwd: "/work", mcpServers });
      const stop = await cx.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "do the ticket" }],
      });
      await cx.request(methods.agent.session.close, { sessionId: session.sessionId });
      return { init, stop };
    });
  return { ...result, updates };
};

describe("createPiAcpAgent", () => {
  it("advertises HTTP MCP, passes the servers to Pi and streams the turn in order", async () => {
    const pi = fakePi(async (emit) => {
      emit({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: {} });
      emit({
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "bash",
        result: "ok",
        isError: false,
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      });
    });
    const { init, stop, updates } = await drive(pi, [
      {
        type: "http",
        name: "project-os",
        url: "http://coord/mcp",
        headers: [{ name: "Authorization", value: "Bearer s3cret" }],
      },
    ]);
    expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: false });
    expect(pi.opened[0]).toEqual({
      cwd: "/work",
      mcpServers: {
        "project-os": {
          url: "http://coord/mcp",
          headers: { Authorization: "Bearer s3cret" },
          exposure: "direct",
        },
      },
    });
    expect(pi.state.prompts).toEqual(["do the ticket"]);
    expect(stop.stopReason).toBe("end_turn");
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(pi.state.disposed).toBe(true);
  });

  it("reports its version and skips unusable MCP servers quietly without a log", async () => {
    const app = createPiAcpAgent({
      createSession: fakePi(async () => {}).createSession,
      version: "1.2.3",
    });
    const info = await client({ name: "test" }).connectWith(app, async (cx) => {
      const init = await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      await cx.request(methods.agent.session.new, {
        cwd: "/work",
        mcpServers: [{ type: "sse", name: "old", url: "http://x/sse", headers: [] }],
      });
      return init.agentInfo;
    });
    expect(info).toMatchObject({ name: "pi-acp", version: "1.2.3" });
  });

  it("fails the prompt with Pi's reason", async () => {
    const pi = fakePi(async () => {
      throw new Error("model unavailable");
    });
    await expect(drive(pi, [])).rejects.toThrow("model unavailable");
  });

  it("fails session/new with the reason Pi could not start", async () => {
    let attempt = 0;
    const app = createPiAcpAgent({
      createSession: async () => {
        // Whatever was thrown, the client gets its text.
        throw attempt++ === 0 ? "Model not found: nope" : new Error("Model not found: nope");
      },
    });
    await expect(
      client({ name: "test" }).connectWith(app, async (cx) => {
        await init(cx);
        return cx.request(methods.agent.session.new, { cwd: "/work", mcpServers: [] });
      }),
    ).rejects.toThrow("Model not found: nope");
    await expect(
      client({ name: "test" }).connectWith(app, async (cx) => {
        await init(cx);
        return cx.request(methods.agent.session.new, { cwd: "/work", mcpServers: [] });
      }),
    ).rejects.toThrow("Model not found: nope");
  });

  it("reports MCP servers Pi cannot use, and ignores non-text prompt content", async () => {
    const logged: string[] = [];
    const pi = fakePi(async () => {});
    const app = createPiAcpAgent({ createSession: pi.createSession, log: (m) => logged.push(m) });
    await client({ name: "test" }).connectWith(app, async (cx) => {
      await init(cx);
      const { sessionId } = await cx.request(methods.agent.session.new, {
        cwd: "/work",
        mcpServers: [{ type: "sse", name: "old", url: "http://x/sse", headers: [] }],
      });
      await cx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "a" },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "b" },
        ],
      });
    });
    expect(logged).toEqual(['MCP server "old" skipped: Pi does not support SSE MCP servers']);
    expect(pi.state.prompts).toEqual(["a\nb"]);
  });

  it("aborts Pi on cancel and ends the turn as cancelled", async () => {
    let release: () => void = () => {};
    const pi = fakePi(() => new Promise<void>((resolve) => (release = resolve)));
    const app = createPiAcpAgent({ createSession: pi.createSession });
    const stop = await client({ name: "test" }).connectWith(app, async (cx) => {
      await init(cx);
      const { sessionId } = await cx.request(methods.agent.session.new, {
        cwd: "/work",
        mcpServers: [],
      });
      const turn = cx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "long job" }],
      });
      await expect.poll(() => pi.state.prompts.length).toBe(1);
      await cx.notify(methods.agent.session.cancel, { sessionId });
      await expect.poll(() => pi.state.aborted).toBe(true);
      release();
      // A cancel for a session that is gone is ignored.
      await cx.notify(methods.agent.session.cancel, { sessionId: "gone" });
      return turn;
    });
    expect(stop.stopReason).toBe("cancelled");
  });

  it("rejects a prompt for an unknown session", async () => {
    const app = createPiAcpAgent({ createSession: fakePi(async () => {}).createSession });
    await expect(
      client({ name: "test" }).connectWith(app, async (cx) => {
        await init(cx);
        return cx.request(methods.agent.session.prompt, {
          sessionId: "nope",
          prompt: [{ type: "text", text: "x" }],
        });
      }),
    ).rejects.toThrow("Unknown session nope");
  });
});
