import { describe, expect, it } from "vite-plus/test";
import type { WatcherConfig } from "./config.ts";
import { bunSpawner, claudeArgs, MCP_SERVER_NAME, mcpConfigJson } from "./spawn.ts";

const config: WatcherConfig = {
  mcpUrl: "http://coord:8080/mcp",
  workerId: "w1",
  workerType: "local_claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/work",
};

describe("claudeArgs", () => {
  const args = claudeArgs(config, "do it");

  it("runs headless with the prompt and MCP config", () => {
    expect(args.slice(0, 4)).toEqual(["claude", "-p", "do it", "--mcp-config"]);
    expect(JSON.parse(args[4]!)).toEqual(JSON.parse(mcpConfigJson(config)));
  });

  it("pre-approves the coordinator MCP tools by the configured server name", () => {
    const i = args.indexOf("--allowedTools");
    expect(args[i + 1]).toBe(`mcp__${MCP_SERVER_NAME}__*`);
    expect(Object.keys(JSON.parse(mcpConfigJson(config)).mcpServers)).toEqual([MCP_SERVER_NAME]);
  });
});

describe("bunSpawner", () => {
  it("spawns claude in the worker cwd with the worker id in the prompt", async () => {
    let seen: { cmd: string[]; cwd: string } | undefined;
    const spawner = bunSpawner(config, (cmd, options) => {
      seen = { cmd, cwd: options.cwd };
      return { exited: Promise.resolve(7) };
    });
    expect(await spawner.spawn()).toBe(7);
    expect(seen?.cwd).toBe("/work");
    expect(seen?.cmd[0]).toBe("claude");
    expect(seen?.cmd[2]).toContain("Your worker_id is `w1`.");
    expect(seen?.cmd[2]).toContain("Project OS Worker");
  });
});
