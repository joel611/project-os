import type { McpClient } from "./poll.ts";

interface RpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message: string };
}

// Minimal MCP streamable-HTTP client: one JSON-RPC tools/call per request.
export const httpMcpClient = (url: string): McpClient => {
  let id = 0;
  return {
    callTool: async (name, args) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      if (!res.ok) throw new Error(`MCP ${name}: HTTP ${res.status}`);
      const body = (await res.json()) as RpcResponse;
      if (body.error) throw new Error(`MCP ${name}: ${body.error.message}`);
      const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "null";
      if (body.result?.isError) throw new Error(`MCP ${name}: ${text}`);
      return JSON.parse(text);
    },
  };
};
