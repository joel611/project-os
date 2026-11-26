import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { gitRunner } from "./git.ts";
import { killProcessGroup } from "./process-group.ts";

const dir = mkdtempSync(join(tmpdir(), "git-runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = {
  PATH: process.env.PATH,
  HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** A server that takes connections and never answers, like a stalled GitHub. */
const stalled = () => {
  let open = 0;
  let closed = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => void open++,
      close: () => void closed++,
      data: () => {},
    },
  });
  return {
    url: `https://127.0.0.1:${server.port}/acme/web.git`,
    open: () => open,
    closed: () => closed,
    stop: () => server.stop(true),
  };
};

describe("gitRunner", () => {
  it("runs git and resolves with its exit code and output", async () => {
    const { run } = gitRunner({ timeoutMs: 10_000 });
    const version = await run(["--version"], { cwd: dir, env });
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^git version /);
    expect(version).not.toHaveProperty("timedOutMs");

    const notRepo = await run(["rev-parse", "HEAD"], { cwd: dir, env });
    expect(notRepo.code).toBe(128);
    expect(notRepo.stderr).toMatch(/not a git repository/);
  });

  it("resolves with 127 when git can't start", async () => {
    const { run } = gitRunner({ timeoutMs: 10_000 });
    const result = await run(["--version"], { cwd: join(dir, "missing"), env });
    expect(result.code).toBe(127);
    expect(result.stderr).not.toBe("");
  });

  it("kills a clone that runs too long, with the remote helper that holds the connection", async () => {
    const server = stalled();
    try {
      const { run } = gitRunner({ timeoutMs: 1_000 });
      const started = Date.now();
      const result = await run(["clone", "--quiet", "--", server.url, join(dir, "stalled")], {
        cwd: dir,
        env,
      });
      expect(result.timedOutMs).toBe(1_000);
      expect(result.code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      // git-remote-https held the connection; killing the group closed it.
      expect(server.open()).toBe(1);
      await vi.waitFor(() => expect(server.closed()).toBe(1));
    } finally {
      server.stop();
    }
  });

  it("stops every command still running when the Watcher stops", async () => {
    const server = stalled();
    try {
      const git = gitRunner({ timeoutMs: 60_000 });
      const clone = git.run(["clone", "--quiet", "--", server.url, join(dir, "stopped")], {
        cwd: dir,
        env,
      });
      await vi.waitFor(() => expect(server.open()).toBe(1));
      git.stopAll();
      const result = await clone;
      expect(result.code).not.toBe(0);
      expect(result).not.toHaveProperty("timedOutMs");
      await vi.waitFor(() => expect(server.closed()).toBe(1));
    } finally {
      server.stop();
    }
  });
});

describe("killProcessGroup", () => {
  it("kills the process alone when it leads no group", () => {
    const kill = vi.fn();
    killProcessGroup({ pid: 2_147_483_647, kill });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
