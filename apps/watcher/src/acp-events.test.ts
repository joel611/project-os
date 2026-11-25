import { describe, expect, it } from "vite-plus/test";
import { makeAcpRunEvents } from "./acp-events.ts";

const chunk = (text: string) =>
  ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }) as const;

describe("makeAcpRunEvents", () => {
  it("joins message chunks into one event, stamped when the message began", () => {
    const events = makeAcpRunEvents();
    expect(events.push(chunk("Claiming "), "t1")).toEqual([]);
    expect(events.push(chunk("the ticket."), "t2")).toEqual([]);
    expect(events.flush("t3")).toEqual([
      { at: "t1", type: "message", text: "Claiming the ticket." },
    ]);
    expect(events.flush("t4")).toEqual([]);
  });

  it("ends a message when a tool call starts, and pairs the result with the tool's name", () => {
    const events = makeAcpRunEvents();
    events.push(chunk("on it"), "t1");
    const started = events.push(
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "ticket_claim", rawInput: { id: 1 } },
      "t2",
    );
    expect(started).toEqual([
      { at: "t1", type: "message", text: "on it" },
      { at: "t2", type: "tool_call", tool: "ticket_claim", text: '{"id":1}' },
    ]);
    expect(
      events.push(
        { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
        "t3",
      ),
    ).toEqual([]);
    expect(
      events.push(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "claimed" } }],
        },
        "t4",
      ),
    ).toEqual([{ at: "t4", type: "tool_result", tool: "ticket_claim", text: "claimed" }]);
  });

  it("records a failed tool call as an error and drops thoughts", () => {
    const events = makeAcpRunEvents();
    events.push({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash" }, "t1");
    expect(
      events.push(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "failed",
          rawOutput: "boom",
        },
        "t2",
      ),
    ).toEqual([{ at: "t2", type: "error", tool: "bash", text: '"boom"' }]);
    expect(
      events.push(
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
        "t3",
      ),
    ).toEqual([]);
    expect(events.flush("t4")).toEqual([]);
  });
});
