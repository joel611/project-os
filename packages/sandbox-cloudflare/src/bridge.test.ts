import { describe, expect, it } from "vite-plus/test";
import { handleBridge, type SandboxStubLike } from "./bridge.ts";

const fake = (proc: { status: string; exitCode?: number } | null = { status: "running" }) => {
  const calls: string[] = [];
  const stub: SandboxStubLike = {
    startProcess: async (command, options) =>
      void calls.push(`start:${command}:${options.processId}:${JSON.stringify(options.env)}`),
    getProcess: async () => proc,
    getProcessLogs: async () => ({ stdout: "out ", stderr: "err" }),
    destroy: async () => void calls.push("destroy"),
  };
  const ids: string[] = [];
  const deps = {
    token: "tok",
    sandbox: (id: string) => {
      ids.push(id);
      return stub;
    },
    newId: () => "s1",
  };
  return { calls, ids, deps };
};

const req = (method: string, path: string, body?: unknown, token = "tok") =>
  new Request(`https://bridge.example${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("sandbox bridge", () => {
  it("starts the command as one process in a new sandbox, with env", async () => {
    const { calls, ids, deps } = fake();
    const res = await handleBridge(
      req("POST", "/sessions", { command: "pi", env: { A: "1" } }),
      deps,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "s1" });
    expect(ids).toEqual(["s1"]);
    expect(calls).toEqual(['start:pi:worker:{"A":"1"}']);
  });

  it("reports a running process", async () => {
    const { deps } = fake({ status: "running" });
    expect(await (await handleBridge(req("GET", "/sessions/s1"), deps)).json()).toEqual({
      state: "running",
    });
  });

  it("reports an exited process with its exit code and output", async () => {
    const { deps } = fake({ status: "failed", exitCode: 3 });
    expect(await (await handleBridge(req("GET", "/sessions/s1"), deps)).json()).toEqual({
      state: "exited",
      exitCode: 3,
      output: "out err",
    });
  });

  it("404s a session it never started", async () => {
    const { deps } = fake(null);
    expect((await handleBridge(req("GET", "/sessions/nope"), deps)).status).toBe(404);
  });

  it("destroys the sandbox on DELETE", async () => {
    const { calls, deps } = fake();
    expect((await handleBridge(req("DELETE", "/sessions/s1"), deps)).status).toBe(204);
    expect(calls).toEqual(["destroy"]);
  });

  it("refuses a wrong token, and every call when no token is set", async () => {
    const { calls, deps } = fake();
    expect((await handleBridge(req("POST", "/sessions", {}, "nope"), deps)).status).toBe(401);
    expect(
      (await handleBridge(req("GET", "/sessions/s1", undefined, ""), { ...deps, token: "" }))
        .status,
    ).toBe(500);
    expect(calls).toEqual([]);
  });

  it("reports a finished process without an exit code by its status", async () => {
    const done = await handleBridge(req("GET", "/sessions/s1"), fake({ status: "completed" }).deps);
    expect(await done.json()).toMatchObject({ exitCode: 0 });
    const killed = await handleBridge(req("GET", "/sessions/s1"), fake({ status: "killed" }).deps);
    expect(await killed.json()).toMatchObject({ exitCode: 1 });
  });

  it("405s other methods on a session", async () => {
    expect((await handleBridge(req("PUT", "/sessions/s1"), fake().deps)).status).toBe(405);
  });

  it("rejects a malformed start and a path that isn't a session id", async () => {
    const { deps } = fake();
    expect((await handleBridge(req("POST", "/sessions", { env: {} }), deps)).status).toBe(400);
    expect(
      (await handleBridge(req("POST", "/sessions", { command: "x", env: null }), deps)).status,
    ).toBe(400);
    const notJson = new Request("https://bridge.example/sessions", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: "{",
    });
    expect((await handleBridge(notJson, deps)).status).toBe(400);
    expect((await handleBridge(req("POST", "/sessions", {}, "tok-but-longer"), deps)).status).toBe(
      401,
    );
    expect((await handleBridge(req("POST", "/sessions", {}, "tik"), deps)).status).toBe(401);
    expect((await handleBridge(req("GET", "/sessions/../x"), deps)).status).toBe(404);
  });
});
