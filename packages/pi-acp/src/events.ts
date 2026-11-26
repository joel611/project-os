import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";

/** The slice of Pi's session events this adapter reads. */
export type PiEvent =
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "message_end";
      message: { role: string; stopReason?: string; errorMessage?: string };
    }
  | { type: string };

const KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  write: "edit",
  bash: "execute",
  grep: "search",
  find: "search",
  ls: "search",
};

export const toolKind = (toolName: string): ToolKind => KINDS[toolName] ?? "other";

/** Text of a tool result: Pi returns `{ content: [{ type: "text", text }] }`, or any value. */
export const resultText = (result: unknown): string => {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as { text?: unknown } | null)?.text)
      .filter((text): text is string => typeof text === "string")
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
};

/** ACP updates for one Pi event; most events (queueing, compaction, …) have none. */
export const toSessionUpdates = (event: PiEvent): SessionUpdate[] => {
  if (event.type === "message_update") {
    const inner = (event as Extract<PiEvent, { type: "message_update" }>).assistantMessageEvent;
    if (inner.type === "text_delta" && inner.delta) {
      return [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta } },
      ];
    }
    if (inner.type === "thinking_delta" && inner.delta) {
      return [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: inner.delta } },
      ];
    }
    return [];
  }
  if (event.type === "tool_execution_start") {
    const start = event as Extract<PiEvent, { type: "tool_execution_start" }>;
    return [
      {
        sessionUpdate: "tool_call",
        toolCallId: start.toolCallId,
        title: start.toolName,
        kind: toolKind(start.toolName),
        status: "in_progress",
        rawInput: start.args,
      },
    ];
  }
  if (event.type === "tool_execution_end") {
    const end = event as Extract<PiEvent, { type: "tool_execution_end" }>;
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: end.toolCallId,
        status: end.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: resultText(end.result) } }],
        rawOutput: end.result,
      },
    ];
  }
  return [];
};
