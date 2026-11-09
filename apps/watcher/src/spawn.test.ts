import { describe, expect, it } from "vite-plus/test";
import { AGENTS, CODEX_TOKEN_ENV } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";
import { bunSpawner, type SpawnerIo } from "./spawn.ts";

const config: WatcherConfig = {
  mcpUrl: "http://coord:8080/mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/work",
  secret: "s3cret",
};

const fakeIo = (existing: Record<string, string> = {}) => {
  const written: Record<string, string> = {};
  const io: SpawnerIo = {
    readFile: (path) => existing[path],
    writePrivate: (path, contents) => {
      written[path] = contents;
    },
    env: { PATH: "/bin" },
    configDir: "/cfg",
    home: "/home/me",
  };
  return { io, written };
};

const run = async (cfg: WatcherConfig, io: SpawnerIo) => {
  let seen: { cmd: string[]; cwd: string; env: Record<string, string | undefined> } | undefined;
  const spawner = bunSpawner(
    cfg,
    (cmd, options) => {
      seen = { cmd, cwd: options.cwd, env: options.env };
      return { exited: Promise.resolve(7) };
    },
    io,
  );
  const code = await spawner.spawn();
  return { code, seen: seen! };
};

describe("bunSpawner", () => {
  it("spawns the configured agent in the worker cwd with the worker id in the prompt", async () => {
    const { io } = fakeIo();
    const { code, seen } = await run(config, io);
    expect(code).toBe(7);
    expect(seen.cwd).toBe("/work");
    expect(seen.cmd[0]).toBe("claude");
    expect(seen.cmd[2]).toContain("Your worker_id is `w1`.");
    expect(seen.cmd[2]).toContain("Project OS Worker");
  });

  it("writes the agent's MCP file before launch, so the secret stays out of ps", async () => {
    const { io, written } = fakeIo();
    const { seen } = await run(config, io);
    expect(seen.cmd[seen.cmd.indexOf("--mcp-config") + 1]).toBe("/cfg/mcp.json");
    expect(written["/cfg/mcp.json"]).toContain("Bearer s3cret");
    expect(seen.cmd.join(" ")).not.toContain("s3cret");
  });

  it("hands the update function the file's current contents (pi merges into the user's)", async () => {
    const path = "/home/me/.pi/agent/mcp.json";
    const { io, written } = fakeIo({
      [path]: JSON.stringify({ mcpServers: { mine: { url: "u" } } }),
    });
    const { seen } = await run({ ...config, agent: "pi" }, io);
    expect(seen.cmd.slice(0, 2)).toEqual(["pi", "--print"]);
    expect(Object.keys(JSON.parse(written[path]!).mcpServers)).toEqual(["mine", "project-os"]);
  });

  it("adds the agent's env on top of the Watcher's own", async () => {
    const { io, written } = fakeIo();
    const { seen } = await run({ ...config, agent: "codex" }, io);
    expect(seen.cmd.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(seen.env).toEqual({ PATH: "/bin", [CODEX_TOKEN_ENV]: "s3cret" });
    expect(written).toEqual({});
  });

  it("takes an explicit agent over the config's", async () => {
    const { io } = fakeIo();
    let cmd: string[] = [];
    await bunSpawner(
      config,
      (c) => {
        cmd = c;
        return { exited: Promise.resolve(0) };
      },
      io,
      AGENTS.codex,
    ).spawn();
    expect(cmd[0]).toBe("codex");
  });
});
