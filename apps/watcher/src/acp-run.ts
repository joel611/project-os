import { client, methods, ndJsonStream, type McpServer } from "@agentclientprotocol/sdk";
import type { RunEvent } from "@project-os/contracts";
import { makeAcpRunEvents } from "./acp-events.ts";
import { MCP_SERVER_NAME } from "./agents.ts";
import { errorMessage } from "./logger.ts";

/** What the Watcher needs of the agent process: bytes in, bytes out. */
export interface AcpProcess {
  readonly exited: Promise<number>;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array> | null | undefined;
  readonly kill: (signal?: "SIGKILL") => void;
}

export interface AcpRunOptions {
  readonly process: AcpProcess;
  readonly cwd: string;
  readonly prompt: string;
  readonly mcpUrl: string;
  readonly secret: string;
  readonly now: () => string;
  readonly onEvent: (event: RunEvent) => void;
}

/**
 * One agent session over ACP: initialize, start a session that carries the Coordinator as an MCP
 * server, send the prompt, and report what the agent did as run events. Resolves with the
 * process-style exit code the rest of the Watcher expects: 0 when the turn ended normally.
 */
export const runAcpSession = async (options: AcpRunOptions): Promise<number> => {
  const events = makeAcpRunEvents();
  const emit = (list: RunEvent[]) => list.forEach(options.onEvent);
  const server: McpServer = {
    type: "http",
    name: MCP_SERVER_NAME,
    url: options.mcpUrl,
    headers: [{ name: "Authorization", value: `Bearer ${options.secret}` }],
  };
  try {
    const stopReason = await client({ name: "project-os-watcher" })
      .onNotification(methods.client.session.update, ({ params }) => {
        emit(events.push(params.update, options.now()));
      })
      // The agent is pre-approved for the Coordinator's tools and runs unattended: if it asks
      // anyway, allow once rather than stall a session nobody is watching.
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const allow = params.options.find((option) => option.kind === "allow_once");
        return allow
          ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      })
      .connectWith(ndJsonStream(options.process.stdin, options.process.stdout), async (agent) => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientInfo: { name: "project-os-watcher", version: "0.0.0" },
          clientCapabilities: {},
        });
        if (!init.agentCapabilities?.mcpCapabilities?.http) {
          throw new Error(
            "the agent cannot use HTTP MCP servers, so it cannot reach the Coordinator",
          );
        }
        const session = await agent.request(methods.agent.session.new, {
          cwd: options.cwd,
          mcpServers: [server],
        });
        options.onEvent({
          at: options.now(),
          type: "lifecycle",
          text: `Session started (${init.agentInfo?.name ?? "agent"} over ACP).`,
        });
        const done = await agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: options.prompt }],
        });
        return done.stopReason;
      });
    emit(events.flush(options.now()));
    options.onEvent({
      at: options.now(),
      type: stopReason === "end_turn" ? "lifecycle" : "error",
      text: `Session finished (${stopReason}).`,
    });
    return stopReason === "end_turn" ? 0 : 1;
  } catch (error) {
    emit(events.flush(options.now()));
    options.onEvent({
      at: options.now(),
      type: "error",
      text: `ACP session failed: ${errorMessage(error)}`,
    });
    return 1;
  } finally {
    options.process.kill();
    await options.process.exited.catch(() => undefined);
  }
};
