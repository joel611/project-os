import { describe, expect, it } from "vite-plus/test";
import { makeSandboxRunner, type DaytonaLike, type SandboxLike } from "./sdk.ts";

const input = { env: { K: "v" }, command: "run-it", timeoutSeconds: 60 };

const quick = { sleep: async () => {}, now: () => 0 };

const fake = (
  polls: Array<{ exitCode?: number | null }>,
  overrides: { noCmdId?: boolean; failDelete?: boolean; noLogs?: boolean } = {},
) => {
  const calls: string[] = [];
  const created: unknown[] = [];
  const sandbox: SandboxLike = {
    process: {
      createSession: async (id) => void calls.push(`session:${id}`),
      executeSessionCommand: async (_id, req) => {
        calls.push(`exec:${req.command}:${req.runAsync}`);
        return overrides.noCmdId ? {} : { cmdId: "c1" };
      },
      getSessionCommand: async () => polls.shift() ?? {},
      getSessionCommandLogs: async () => (overrides.noLogs ? {} : { output: "logs" }),
    },
    delete: async () => {
      calls.push("delete");
      if (overrides.failDelete) throw new Error("gone");
    },
  };
  const daytona: DaytonaLike = {
    create: async (params) => {
      created.push(params);
      return sandbox;
    },
  };
  return { daytona, calls, created };
};

describe("daytona sandbox runner", () => {
  it("creates an ephemeral sandbox with the env, polls until exit, returns logs and deletes", async () => {
    const { daytona, calls, created } = fake([{}, { exitCode: null }, { exitCode: 0 }]);
    const slept: number[] = [];
    const runner = makeSandboxRunner(daytona, {
      snapshot: "snap",
      sleep: async (ms) => void slept.push(ms),
      now: () => 0,
    });
    expect(await runner.run(input)).toEqual({ exitCode: 0, output: "logs" });
    expect(created).toEqual([
      { envVars: { K: "v" }, ephemeral: true, autoStopInterval: 5, snapshot: "snap" },
    ]);
    expect(calls).toEqual(["session:worker", "exec:run-it:true", "delete"]);
    expect(slept).toEqual([5000, 5000]);
  });

  it("omits the snapshot when none is configured", async () => {
    const { daytona, created } = fake([{ exitCode: 1 }]);
    const out = await makeSandboxRunner(daytona, quick).run(input);
    expect(out.exitCode).toBe(1);
    expect(created).toEqual([{ envVars: { K: "v" }, ephemeral: true, autoStopInterval: 5 }]);
  });

  it("deletes the sandbox and fails when the session outlives the timeout", async () => {
    const { daytona, calls } = fake([{}, {}, {}]);
    let t = 0;
    const runner = makeSandboxRunner(daytona, {
      sleep: quick.sleep,
      now: () => (t += 40_000),
    });
    await expect(runner.run(input)).rejects.toThrow("session exceeded 60s");
    expect(calls.at(-1)).toBe("delete");
  });

  it("fails without a command id, still deleting", async () => {
    const { daytona, calls } = fake([], { noCmdId: true });
    await expect(makeSandboxRunner(daytona, quick).run(input)).rejects.toThrow("no command id");
    expect(calls.at(-1)).toBe("delete");
  });

  it("returns empty output when Daytona has no logs", async () => {
    const { daytona } = fake([{ exitCode: 0 }], { noLogs: true });
    expect(await makeSandboxRunner(daytona, quick).run(input)).toEqual({ exitCode: 0, output: "" });
  });

  it("ignores a failing delete", async () => {
    const { daytona } = fake([{ exitCode: 0 }], { failDelete: true });
    expect(await makeSandboxRunner(daytona, quick).run(input)).toMatchObject({ exitCode: 0 });
  });
});
