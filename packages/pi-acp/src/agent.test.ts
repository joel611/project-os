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

  it("fails the prompt when Pi fails", async () => {
    const pi = fakePi(async () => {
      throw new Error("model unavailable");
    });
    await expect(drive(pi, [])).rejects.toThrow();
  });
});
