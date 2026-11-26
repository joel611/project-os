import type { McpServer } from "@agentclientprotocol/sdk";

/** One MCP server in the shape Pi's `mcp.json` and `pi.registerMcpServer()` take. */
export type PiMcpServer =
  | { readonly url: string; readonly headers?: Record<string, string>; readonly exposure: "direct" }
  | {
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Record<string, string>;
      readonly exposure: "direct";
    };

export interface ConvertedMcpServers {
  readonly servers: Readonly<Record<string, PiMcpServer>>;
  /** Servers Pi cannot reach, with why; the caller reports these instead of dropping them silently. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

const toMap = (pairs: ReadonlyArray<{ readonly name: string; readonly value: string }>) =>
  Object.fromEntries(pairs.map(({ name, value }) => [name, value]));

/**
 * ACP's `session/new` lists MCP servers with headers and env as name/value arrays and allows SSE;
 * Pi wants objects and has no SSE. Tools are declared to the model directly (`exposure: "direct"`),
 * because the default would hide them behind codemode.
 */
export const convertMcpServers = (mcpServers: ReadonlyArray<McpServer>): ConvertedMcpServers => {
  const servers: Record<string, PiMcpServer> = {};
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const server of mcpServers) {
    if ("type" in server && server.type === "sse") {
      skipped.push({ name: server.name, reason: "Pi does not support SSE MCP servers" });
    } else if ("type" in server && server.type === "http") {
      servers[server.name] = {
        url: server.url,
        ...(server.headers.length > 0 && { headers: toMap(server.headers) }),
        exposure: "direct",
      };
    } else {
      servers[server.name] = {
        command: server.command,
        args: server.args,
        ...(server.env.length > 0 && { env: toMap(server.env) }),
        exposure: "direct",
      };
    }
  }
  return { servers, skipped };
};
