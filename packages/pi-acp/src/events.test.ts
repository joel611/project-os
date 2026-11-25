import { describe, expect, it } from "vite-plus/test";
import { resultText, toSessionUpdates, toolKind } from "./events.ts";

describe("toSessionUpdates", () => {
  it("streams text and thinking deltas", () => {
    expect(
      toSessionUpdates({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
    ).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }]);
    expect(
      toSessionUpdates({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hm" },
      }),
    ).toEqual([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }]);
  });

  it("ignores other message updates and unrelated events", () => {
    expect(
      toSessionUpdates({ type: "message_update", assistantMessageEvent: { type: "start" } }),
    ).toEqual([]);
    expect(toSessionUpdates({ type: "queue_update" })).toEqual([]);
  });

  it("reports a tool call and its outcome", () => {
    expect(
      toSessionUpdates({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      }),
    ).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
    ]);
    const [done] = toSessionUpdates({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "a\nb" }] },
      isError: false,
    });
    expect(done).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
    const [failed] = toSessionUpdates({
      type: "tool_execution_end",
      toolCallId: "t2",
      toolName: "mcp__project-os__ticket_claim",
      result: "nope",
      isError: true,
    });
    expect(failed).toMatchObject({ status: "failed" });
  });

  it("reads tool result text from content parts, strings or other values", () => {
    expect(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a");
    expect(resultText("plain")).toBe("plain");
    expect(resultText({ ok: true })).toBe('{"ok":true}');
    expect(toolKind("mcp__x__y")).toBe("other");
  });
});
