import { describe, expect, it } from "vite-plus/test";
import { makeClaudeParser, terminalText } from "./run-events.ts";

const AT = "2026-11-04T00:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value);

describe("claude stream-json parser", () => {
  it("reads a session into messages, tool calls with their results, and the outcome", () => {
    const parse = makeClaudeParser();
    const events = [
      line({ type: "system", subtype: "init", model: "opus", tools: [1, 2, 3] }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "a", content: "file.txt" }] },
      }),
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "a",
              content: [{ type: "text", text: "nope" }],
              is_error: true,
            },
          ],
        },
      }),
      line({
        type: "result",
        subtype: "success",
        duration_ms: 2000,
        num_turns: 3,
        total_cost_usd: 0.5,
      }),
    ].flatMap((l) => parse(l, AT));

    expect(events.map((e) => [e.type, e.tool, e.text])).toEqual([
      ["lifecycle", undefined, "Session started (opus, 3 tools)."],
      ["message", undefined, "On it."],
      ["tool_call", "Bash", '{"command":"ls"}'],
      ["tool_result", "Bash", "file.txt"],
      ["error", "Bash", "nope"],
      ["lifecycle", undefined, "Session finished (2s, 3 turns, $0.5000)."],
    ]);
  });

  it("flags a failed result and keeps unknown or non-JSON lines as output", () => {
    const parse = makeClaudeParser();
    expect(
      parse(line({ type: "result", subtype: "error_max_turns", is_error: true }), AT)[0],
    ).toMatchObject({
      type: "error",
    });
    expect(parse("not json", AT)).toEqual([{ at: AT, type: "output", text: "not json" }]);
    expect(parse(line({ type: "mystery" }), AT)[0]).toMatchObject({ type: "output" });
  });

  it("shows readable lines on the terminal and hides bulky tool results", () => {
    expect(terminalText({ at: AT, type: "message", text: "hi" })).toBe("hi");
    expect(terminalText({ at: AT, type: "tool_call", tool: "Bash", text: "{}" })).toBe("→ Bash {}");
    expect(terminalText({ at: AT, type: "tool_result", text: "big" })).toBeUndefined();
  });
});
