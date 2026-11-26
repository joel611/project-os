import {
  agent,
  CLIENT_METHODS,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type ContentBlock,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { toSessionUpdates } from "./events.ts";
import { convertMcpServers } from "./mcp.ts";
import type { PiRun, PiSessionFactory } from "./session.ts";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface PiAcpOptions {
  readonly createSession: PiSessionFactory;
  readonly version?: string;
  /** Where the adapter reports things the client cannot see (stdout is the protocol). */
  readonly log?: (message: string) => void;
}

/** The text of a prompt; Pi takes text, so other content (images, resources) is left out. */
export const promptText = (prompt: ReadonlyArray<ContentBlock>): string =>
  prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

interface LiveSession {
  readonly run: PiRun;
  cancelled: boolean;
}

/**
 * An ACP agent that runs Pi. One ACP session is one Pi session; `mcpServers` from `session/new`
 * become Pi MCP servers for that session only. Pi asks no permission before running tools, so
 * `session/request_permission` is never sent.
 */
export const createPiAcpAgent = (options: PiAcpOptions): AgentApp => {
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, LiveSession>();
  const find = (sessionId: string): LiveSession => {
    const live = sessions.get(sessionId);
    if (!live) throw RequestError.invalidParams(undefined, `Unknown session ${sessionId}`);
    return live;
  };

  return agent({ name: "pi-acp" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "pi-acp", title: "Pi", version: options.version ?? "0.0.0" },
      agentCapabilities: {
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: {},
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const { servers, skipped } = convertMcpServers(params.mcpServers);
      for (const { name, reason } of skipped) log(`MCP server "${name}" skipped: ${reason}`);
      // The protocol's own "internal error" would hide why; carry the reason to the client.
      const run = await options
        .createSession({ cwd: params.cwd, mcpServers: servers })
        .catch((error: unknown) => {
          throw RequestError.internalError(undefined, reason(error));
        });
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { run, cancelled: false });
      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const live = find(params.sessionId);
      live.cancelled = false;
      // Updates go out in the order Pi produced them.
      let sent: Promise<unknown> = Promise.resolve();
      const send = (update: SessionUpdate) => {
        sent = sent.then(() =>
          client.notify(CLIENT_METHODS.session_update, { sessionId: params.sessionId, update }),
        );
      };
      const unsubscribe = live.run.subscribe((event) => {
        for (const update of toSessionUpdates(event)) send(update);
      });
      try {
        await live.run.prompt(promptText(params.prompt));
      } catch (error) {
        throw RequestError.internalError(undefined, reason(error));
      } finally {
        unsubscribe();
        await Promise.allSettled([sent]);
      }
      return { stopReason: live.cancelled ? "cancelled" : "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const live = sessions.get(params.sessionId);
      if (!live) return;
      live.cancelled = true;
      await live.run.abort();
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      sessions.get(params.sessionId)?.run.dispose();
      sessions.delete(params.sessionId);
    });
};
