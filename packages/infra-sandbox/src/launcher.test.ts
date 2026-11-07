import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  makeSandboxLauncher,
  piMcpJson,
  SESSION_COMMAND,
  type SandboxProvider,
  type SandboxRunner,
} from "./launcher.ts";

const setup = (run: SandboxRunner["run"], extra: ReadonlyArray<SandboxProvider> = []) => {
  const logs: string[] = [];
  const launcher = makeSandboxLauncher({
    providers: [{ workerType: "daytona_pi", runner: { run } }, ...extra],
    mcpUrl: "https://tunnel.example/mcp",
    openrouterApiKey: "sk-or",
    model: "openrouter/m",
    prompt: "Work one ticket.",
    log: (m) => logs.push(m),
  });
  return { launcher, logs };
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const daytonaTicket = {
  ticketId: "t1",
  workerType: "daytona_pi",
  workerId: "daytona-t1",
} as const;
const ok = async () => ({ exitCode: 0, output: "" });

describe("sandbox launcher", () => {
  it("runs a Pi session with worker id, MCP config and key as env, not in the shell line", async () => {
    const calls: Parameters<SandboxRunner["run"]>[0][] = [];
    const { launcher } = setup(async (input) => {
      calls.push(input);
      return { exitCode: 0, output: "" };
    });
    await Effect.runPromise(launcher.launch(daytonaTicket));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(SESSION_COMMAND);
    expect(calls[0]!.env).toEqual({
      OPENROUTER_API_KEY: "sk-or",
      PROJECT_OS_MCP_JSON: piMcpJson("https://tunnel.example/mcp"),
      PROJECT_OS_MODEL: "openrouter/m",
      PROJECT_OS_PROMPT: "Work one ticket.\nYour worker_id is `daytona-t1`.",
    });
    expect(JSON.parse(calls[0]!.env.PROJECT_OS_MCP_JSON!)).toEqual({
      mcpServers: { "project-os": { url: "https://tunnel.example/mcp", exposure: "direct" } },
    });
  });

  it("starts the ticket on the provider it was assigned to", async () => {
    const ran: string[] = [];
    const { launcher, logs } = setup(async () => {
      ran.push("daytona");
      return { exitCode: 0, output: "" };
    }, [
      {
        workerType: "cloudflare_pi",
        runner: {
          run: async () => {
            ran.push("cloudflare");
            return { exitCode: 0, output: "" };
          },
        },
      },
    ]);
    await Effect.runPromise(
      launcher.launch({
        ticketId: "t2",
        workerType: "cloudflare_pi",
        workerId: "cloudflare-t2",
      }),
    );
    await settle();
    expect(ran).toEqual(["cloudflare"]);
    expect(logs).toEqual([
      "cloudflare: launching cloudflare-t2 for ticket t2",
      "cloudflare: cloudflare-t2 finished",
    ]);
  });

  it("reports its providers as the pool, in order, with caps", async () => {
    const { launcher } = setup(ok, [
      { workerType: "cloudflare_pi", runner: { run: ok }, maxConcurrent: 3 },
    ]);
    expect(await Effect.runPromise(launcher.pool)).toEqual([
      { workerType: "daytona_pi" },
      { workerType: "cloudflare_pi", maxConcurrent: 3 },
    ]);
  });

  it("ignores worker types outside the pool", async () => {
    let ran = false;
    const { launcher } = setup(async () => {
      ran = true;
      return { exitCode: 0, output: "" };
    });
    await Effect.runPromise(
      launcher.launch({ ticketId: "t1", workerType: "local_claude", workerId: "w" }),
    );
    await Effect.runPromise(
      launcher.launch({
        ticketId: "t1",
        workerType: "cloudflare_pi",
        workerId: "cloudflare-t1",
      }),
    );
    expect(ran).toBe(false);
  });

  it("logs a rejected session without throwing from launch", async () => {
    const { launcher, logs } = setup(() => Promise.reject(new Error("no capacity")));
    await Effect.runPromise(launcher.launch(daytonaTicket));
    await settle();
    expect(logs.at(-1)).toBe("daytona: daytona-t1 failed: no capacity");
  });

  it("logs a non-Error rejection as text", async () => {
    const { launcher, logs } = setup(() => Promise.reject("boom"));
    await Effect.runPromise(launcher.launch(daytonaTicket));
    await settle();
    expect(logs.at(-1)).toBe("daytona: daytona-t1 failed: boom");
  });

  it("logs the output tail of a non-zero exit", async () => {
    const { launcher, logs } = setup(async () => ({ exitCode: 2, output: "pi: bad model" }));
    await Effect.runPromise(launcher.launch(daytonaTicket));
    await settle();
    expect(logs.at(-1)).toBe("daytona: daytona-t1 exited 2: pi: bad model");
  });
});
