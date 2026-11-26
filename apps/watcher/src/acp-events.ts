import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { RunEvent } from "@project-os/contracts";

interface Content {
  readonly type: string;
  readonly text?: string;
}

const contentText = (content: unknown): string => {
  const block = content as Content | undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
};

/** Text of a tool call's content: `{type: "content", content: ContentBlock}` entries. */
const toolContentText = (content: ReadonlyArray<unknown> | null | undefined): string =>
  (content ?? [])
    .map((entry) => contentText((entry as { content?: unknown }).content))
    .filter((text) => text !== "")
    .join("\n");

export interface AcpRunEvents {
  /** The run events for one `session/update`. Message chunks are held back until the message ends. */
  readonly push: (update: SessionUpdate, at: string) => RunEvent[];
  /** What is still held back; call when the turn ends. */
  readonly flush: (at: string) => RunEvent[];
}

/**
 * Turns an ACP `session/update` stream into run events. Agents send a message as many small
 * chunks, so consecutive chunks are joined into one `message` event, which ends when anything
 * else arrives. Thoughts are not recorded, and a tool call is recorded once when it starts and
 * once when it ends.
 */
export const makeAcpRunEvents = (): AcpRunEvents => {
  let text = "";
  let textAt = "";
  const tools = new Map<string, string>();

  const flush = (): RunEvent[] => {
    if (text === "") return [];
    const event: RunEvent = { at: textAt, type: "message", text };
    text = "";
    return [event];
  };

  return {
    flush,
    push: (update, at) => {
      if (update.sessionUpdate === "agent_message_chunk") {
        const chunk = contentText(update.content);
        if (chunk === "") return [];
        if (text === "") textAt = at;
        text += chunk;
        return [];
      }
      if (update.sessionUpdate === "tool_call") {
        tools.set(update.toolCallId, update.title);
        return [
          ...flush(),
          {
            at,
            type: "tool_call",
            tool: update.title,
            text: JSON.stringify(update.rawInput ?? {}),
          },
        ];
      }
      if (update.sessionUpdate === "tool_call_update") {
        if (update.title) tools.set(update.toolCallId, update.title);
        if (update.status !== "completed" && update.status !== "failed") return [];
        const tool = tools.get(update.toolCallId);
        const body = toolContentText(update.content);
        return [
          ...flush(),
          {
            at,
            type: update.status === "failed" ? "error" : "tool_result",
            ...(tool && { tool }),
            text: body || (update.rawOutput === undefined ? "" : JSON.stringify(update.rawOutput)),
          },
        ];
      }
      return [];
    },
  };
};
