import { describe, expect, it } from "vite-plus/test";
import type { WatcherConfig } from "./config.ts";
import { createWatcher } from "./poll.ts";
import { redact } from "./tail.ts";

const config: WatcherConfig = {
  mcpUrl: "http://coord:8080/mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/work",
  secret: "s3cret-value",
};

describe("watcher session without a ticket id", () => {
  it("runs the session and reports nothing", async () => {
    const calls: string[] = [];
    const watcher = createWatcher({
      config,
      client: {
        callTool: async (name) => {
          calls.push(name);
          return name === "ticket_list_assigned" ? { tickets: [{}] } : {};
        },
      },
      spawner: { spawn: async () => 0 },
      log: () => {},
    });
    await watcher.pollOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).not.toContain("ticket_append_event");
    expect(watcher.running()).toBe(0);
  });
});

describe("redact secrets", () => {
  it("ignores secrets too short to be one", () => {
    expect(redact("a short abc here", ["abc"])).toBe("a short abc here");
  });
});
