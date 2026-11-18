import { describe, expect, it } from "vite-plus/test";
import type { WatcherConfig } from "./config.ts";
import { createWatcher } from "./poll.ts";
import { bunSpawner, type Spawner } from "./spawn.ts";

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

const setup = (spawn: Spawner["spawn"], appendFails = false) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const watcher = createWatcher({
    config,
    client: {
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "ticket_append_event" && appendFails) throw new Error("coordinator down");
        return name === "ticket_list_assigned" ? { tickets: [{ id: "tk-1" }] } : {};
      },
    },
    spawner: { spawn },
    log: (m) => logs.push(m),
  });
  const settle = async () => {
    await watcher.pollOnce();
    await new Promise((r) => setTimeout(r, 0));
  };
  const reports = () => calls.filter((c) => c.name === "ticket_append_event").map((c) => c.args);
  return { settle, reports, logs };
};

describe("watcher session report", () => {
  it("records exit code and a redacted output tail on the ticket", async () => {
    const { settle, reports } = setup(async (onOutput) => {
      onOutput?.(
        "Blocked: 404 for joel611/project-os\nGH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n",
      );
      return 0;
    });
    await settle();
    const [report] = reports();
    expect(report).toMatchObject({
      ticketId: "tk-1",
      type: "system",
      actor: "worker",
      actorId: config.workerId,
      payload: { kind: "watcher_session", exitCode: 0 },
    });
    const tail = (report!.payload as { tail: string }).tail;
    expect(tail).toContain("Blocked: 404");
    expect(tail).not.toContain("ghp_");
  });

  it("records a session that could not run", async () => {
    const { settle, reports } = setup(() => Promise.reject(new Error("spawn ENOENT")));
    await settle();
    expect(reports()[0]).toMatchObject({
      payload: { kind: "watcher_session", error: "spawn ENOENT" },
    });
  });

  it("logs, and keeps running, when the report cannot be sent", async () => {
    const { settle, logs } = setup(async () => 1, true);
    await settle();
    expect(logs.some((l) => l.includes("session report failed: coordinator down"))).toBe(true);
  });
});

describe("bunSpawner output", () => {
  it("shows agent output on the terminal and hands it to onOutput", async () => {
    const shown: string[] = [];
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
    const spawner = bunSpawner(
      config,
      () => ({ exited: Promise.resolve(0), stdout: stream("out\n"), stderr: stream("err\n") }),
      {
        readFile: () => undefined,
        writePrivate: () => {},
        write: (name, chunk) => void shown.push(`${name}:${new TextDecoder().decode(chunk)}`),
        env: {},
        configDir: "/cfg",
        home: "/home/me",
      },
    );
    const seen: string[] = [];
    expect(await spawner.spawn((c) => seen.push(c))).toBe(0);
    expect(shown.sort()).toEqual(["stderr:err\n", "stdout:out\n"]);
    expect(seen.sort()).toEqual(["err\n", "out\n"]);
  });
});
