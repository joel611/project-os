import { describe, expect, it } from "vite-plus/test";
import { convertMcpServers } from "./mcp.ts";

describe("convertMcpServers", () => {
  it("turns header and env arrays into objects and declares tools directly", () => {
    const { servers, skipped } = convertMcpServers([
      {
        type: "http",
        name: "project-os",
        url: "http://coord/mcp",
        headers: [{ name: "Authorization", value: "Bearer s3cret" }],
      },
      {
        name: "local",
        command: "/bin/tool",
        args: ["--x"],
        env: [{ name: "A", value: "1" }],
      },
    ]);
    expect(skipped).toEqual([]);
    expect(servers["project-os"]).toEqual({
      url: "http://coord/mcp",
      headers: { Authorization: "Bearer s3cret" },
      exposure: "direct",
    });
    expect(servers.local).toEqual({
      command: "/bin/tool",
      args: ["--x"],
      env: { A: "1" },
      exposure: "direct",
    });
  });

  it("leaves out empty headers and env", () => {
    const { servers } = convertMcpServers([
      { type: "http", name: "open", url: "http://x/mcp", headers: [] },
      { name: "bare", command: "/bin/t", args: [], env: [] },
    ]);
    expect(servers.open).toEqual({ url: "http://x/mcp", exposure: "direct" });
    expect(servers.bare).toEqual({ command: "/bin/t", args: [], exposure: "direct" });
  });

  it("reports SSE servers instead of dropping them silently", () => {
    const { servers, skipped } = convertMcpServers([
      { type: "sse", name: "old", url: "http://x/sse", headers: [] },
    ]);
    expect(servers).toEqual({});
    expect(skipped).toEqual([{ name: "old", reason: "Pi does not support SSE MCP servers" }]);
  });
});
