import { describe, expect, it } from "vite-plus/test";
import { type BoatLike, makeBoatRunner } from "./runner.ts";

const input = { env: { K: "v" }, command: "run-it", timeoutSeconds: 60 };

type Status = Awaited<ReturnType<BoatLike["commandStatus"]>>;
const running: Status = { status: "running", exitCode: null, stdout: "", stderr: "" };

const fake = (polls: Status[], overrides: { failDelete?: boolean } = {}) => {
  const calls: string[] = [];
  const created: unknown[] = [];
  const boat: BoatLike = {
    create: async (params) => {
      created.push(params);
      return { sandbox: { id: "sb1" } };
    },
    waitUntilReady: async (id) => void calls.push(`ready:${id}`),
    startCommand: async (id, command) => {
      calls.push(`start:${id}:${command}`);
      return { processId: 7 };
    },
    commandStatus: async (id, pid) => {
      calls.push(`status:${id}:${pid}`);
      return polls.shift() ?? running;
    },
    deleteSandbox: async (id) => {
      calls.push(`delete:${id}`);
      if (overrides.failDelete) throw new Error("gone");
    },
  };
  return { boat, calls, created };
};

const quick = { sleep: async () => {}, now: () => 0 };

describe("boat runner", () => {
  it("creates a sandbox with env, runs the command detached, polls to exit, then deletes", async () => {
    const { boat, calls, created } = fake([
      running,
      { status: "exited", exitCode: 0, stdout: "out ", stderr: "err" },
    ]);
    expect(await makeBoatRunner(boat, quick).run(input)).toEqual({
      exitCode: 0,
      output: "out err",
    });
    expect(created).toEqual([{ ttlSeconds: 360, env: { K: "v" } }]);
    expect(calls).toEqual([
      "ready:sb1",
      "start:sb1:run-it",
      "status:sb1:7",
      "status:sb1:7",
      "delete:sb1",
    ]);
  });

  it("passes the configured size and keeps the last 4000 characters of output", async () => {
    const { boat, created } = fake([
      { status: "exited", exitCode: 2, stdout: "x".repeat(5000), stderr: "tail" },
    ]);
    const result = await makeBoatRunner(boat, { ...quick, size: "large" }).run(input);
    expect(created).toEqual([{ ttlSeconds: 360, env: { K: "v" }, type: "large" }]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toHaveLength(4000);
    expect(result.output.endsWith("tail")).toBe(true);
  });

  it("reports a lost process as a failure", async () => {
    const { boat } = fake([{ status: "lost", exitCode: null, stdout: "", stderr: "" }]);
    expect((await makeBoatRunner(boat, quick).run(input)).exitCode).toBe(1);
  });

  it("gives up after the timeout and still deletes the sandbox", async () => {
    const { boat, calls } = fake([]);
    let t = 0;
    const runner = makeBoatRunner(boat, { sleep: async () => {}, now: () => (t += 30_000) });
    await expect(runner.run(input)).rejects.toThrow("session exceeded 60s");
    expect(calls.at(-1)).toBe("delete:sb1");
  });

  it("returns the result even when deleting fails", async () => {
    const { boat } = fake([{ status: "exited", exitCode: 0, stdout: "", stderr: "" }], {
      failDelete: true,
    });
    expect(await makeBoatRunner(boat, quick).run(input)).toEqual({ exitCode: 0, output: "" });
  });

  it("deletes the sandbox when it never becomes ready", async () => {
    const { boat, calls } = fake([]);
    const broken: BoatLike = {
      ...boat,
      waitUntilReady: () => Promise.reject(new Error("no capacity")),
    };
    await expect(makeBoatRunner(broken, quick).run(input)).rejects.toThrow("no capacity");
    expect(calls).toEqual(["delete:sb1"]);
  });
});
