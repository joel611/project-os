import type { RunEvent } from "@project-os/contracts";

/** Turns one line an agent printed into events. */
export type LineParser = (line: string, at: string) => ReadonlyArray<RunEvent>;

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => asObject(part)?.text)
      .filter((text): text is string => typeof text === "string")
      .join("\n");
  }
  return value === undefined ? "" : JSON.stringify(value);
};

/** A plain line of stdout or stderr; stderr lines carry `tool: "stderr"`. */
export const outputEvent = (text: string, at: string, stream: "stdout" | "stderr"): RunEvent => ({
  at,
  type: "output",
  text,
  ...(stream === "stderr" ? { tool: "stderr" } : {}),
});

const resultText = (msg: Json): RunEvent["text"] => {
  const usage = asObject(msg.usage);
  const bits = [
    typeof msg.duration_ms === "number" ? `${Math.round(msg.duration_ms / 1000)}s` : undefined,
    typeof msg.num_turns === "number" ? `${msg.num_turns} turns` : undefined,
    usage && typeof usage.input_tokens === "number"
      ? `${usage.input_tokens} in / ${String(usage.output_tokens ?? 0)} out tokens`
      : undefined,
    typeof msg.total_cost_usd === "number" ? `$${msg.total_cost_usd.toFixed(4)}` : undefined,
  ].filter(Boolean);
  const failed = isFailedResult(msg);
  const head = failed
    ? `Session ended with ${String(msg.subtype ?? "an error")}`
    : "Session finished";
  const detail = bits.length > 0 ? ` (${bits.join(", ")})` : "";
  const reason = failed && typeof msg.result === "string" ? `: ${msg.result}` : ".";
  return `${head}${detail}${reason}`;
};

const isFailedResult = (msg: Json): boolean =>
  msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success");

/**
 * Parser for Claude Code's `--output-format stream-json`: one JSON object per line, being the
 * session start, an assistant turn (text and tool calls), the tool results the user turn carries,
 * and a final result. A line that isn't one of these is kept as plain output, so nothing is lost
 * when the format changes.
 */
export const makeClaudeParser = (): LineParser => {
  const toolNames = new Map<string, string>();
  return (line, at) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [outputEvent(line, at, "stdout")];
    }
    const msg = asObject(parsed);
    if (!msg) return [outputEvent(line, at, "stdout")];
    if (msg.type === "system" && msg.subtype === "init") {
      const model = typeof msg.model === "string" ? msg.model : "unknown model";
      const tools = Array.isArray(msg.tools) ? msg.tools.length : 0;
      return [{ at, type: "lifecycle", text: `Session started (${model}, ${tools} tools).` }];
    }
    if (msg.type === "assistant" || msg.type === "user") {
      const content = asObject(msg.message)?.content;
      if (typeof content === "string") {
        return msg.type === "assistant" ? [{ at, type: "message", text: content }] : [];
      }
      if (!Array.isArray(content)) return [outputEvent(line, at, "stdout")];
      return content.flatMap((raw): RunEvent[] => {
        const part = asObject(raw);
        if (!part) return [];
        if (part.type === "text" && typeof part.text === "string") {
          return [{ at, type: "message", text: part.text }];
        }
        if (part.type === "tool_use") {
          const name = typeof part.name === "string" ? part.name : "tool";
          if (typeof part.id === "string") toolNames.set(part.id, name);
          return [{ at, type: "tool_call", tool: name, text: JSON.stringify(part.input ?? {}) }];
        }
        if (part.type === "tool_result") {
          const name =
            typeof part.tool_use_id === "string" ? toolNames.get(part.tool_use_id) : undefined;
          return [
            {
              at,
              type: part.is_error === true ? "error" : "tool_result",
              ...(name && { tool: name }),
              text: asText(part.content),
            },
          ];
        }
        return [];
      });
    }
    if (msg.type === "result") {
      return [{ at, type: isFailedResult(msg) ? "error" : "lifecycle", text: resultText(msg) }];
    }
    return [outputEvent(line, at, "stdout")];
  };
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** What someone watching the Watcher's terminal sees for an event of a structured agent. */
export const terminalText = (event: RunEvent): string | undefined => {
  switch (event.type) {
    case "tool_call":
      return `→ ${event.tool ?? "tool"} ${clip(event.text, 200)}`;
    case "tool_result":
      return undefined;
    case "error":
      return `! ${clip(event.text, 500)}`;
    case "message":
    case "lifecycle":
    case "output":
      return event.text;
  }
};
