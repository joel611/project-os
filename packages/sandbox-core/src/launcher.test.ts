import { workerSessionStart } from "@project-os/system-prompts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  makeSandboxLauncher,
  piMcpJson,
  PROXIED_SESSION_COMMAND,
  SESSION_COMMAND,
  type SandboxProvider,
  type SandboxRunner,
} from "./launcher.ts";

const setup = (
  run: SandboxRunner["run"],
  extra: ReadonlyArray<SandboxProvider> = [],
  egressUrl?: string,
) => {
  const logs: string[] = [];
  const launcher = makeSandboxLauncher({
    providers: [{ workerType: "daytona_pi", runner: { run } }, ...extra],
    mcpUrl: "https://tunnel.example/mcp",
    openrouterApiKey: "sk-or",
    model: "openrouter/m",
    ...(egressUrl && { egressUrl }),
    log: (m) => logs.push(m),
  });
  return { launcher, logs };
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const daytonaTicket = {
  ticketId: "t1",
  workerType: "daytona_pi",
  workerId: "daytona-t1",
  mcpToken: "mcp-token-t1",
} as const;
const ok = async () => ({ exitCode: 0, output: "" });

/** Runs `script` with `sh`, without blocking the event loop (the test's own server must answer). */
const sh = async (script: string, env: Record<string, string>) => {
  const { spawn } = await import("node:child_process");
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("sh", ["-c", script], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
};

describe("skills step", () => {
  it("installs the ticket's skills before Pi runs, and never stops the session when it can't", () => {
    const steps = SESSION_COMMAND.split(" && ");
    const skills = steps.findIndex((s) => s.includes("PROJECT_OS_SKILLS_URL"));
    expect(skills).toBeGreaterThan(steps.findIndex((s) => s.includes("npm install")));
    expect(skills).toBeLessThan(steps.findIndex((s) => s.startsWith("pi ")));
    expect(steps[skills]).toMatch(/\|\| true$/);
    // The token is read from the environment, never written into the command line.
    expect(SESSION_COMMAND).not.toContain("mcp-token");
  });

  it("runs the installer against a bundle, writing only inside each skill's folder", async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "skills-home-"));
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        expect(req.headers.get("authorization")).toBe("Bearer tok");
        return Response.json({
          set: { id: "s", name: "development" },
          skills: [
            {
              slug: "tdd",
              name: "tdd",
              files: [
                { path: "SKILL.md", contents: "# tdd" },
                { path: "examples/a.ts", contents: "export {}" },
                { path: "../escape.txt", contents: "no" },
              ],
            },
            { slug: "../bad", name: "bad", files: [{ path: "SKILL.md", contents: "no" }] },
          ],
        });
      },
    });
    try {
      const script = SESSION_COMMAND.split(" && ").find((s) =>
        s.includes("PROJECT_OS_SKILLS_URL"),
      )!;
      const out = await sh(script, {
        HOME: home,
        PROJECT_OS_SKILLS_URL: `http://localhost:${server.port}/tickets/t1/skills`,
        PROJECT_OS_SKILLS_TOKEN: "tok",
      });
      expect(out.stdout).toContain("skills: installed 1");
      const root = join(home, ".pi", "agent", "skills");
      expect(readFileSync(join(root, "tdd", "SKILL.md"), "utf8")).toBe("# tdd");
      expect(readFileSync(join(root, "tdd", "examples", "a.ts"), "utf8")).toBe("export {}");
      expect(existsSync(join(root, "escape.txt"))).toBe(false);
      expect(existsSync(join(root, "tdd", "..", "bad"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("reports and carries on when the Coordinator refuses", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 403 }) });
    try {
      const script = SESSION_COMMAND.split(" && ").find((s) =>
        s.includes("PROJECT_OS_SKILLS_URL"),
      )!;
      const out = await sh(script, {
        PROJECT_OS_SKILLS_URL: `http://localhost:${server.port}/x`,
        PROJECT_OS_SKILLS_TOKEN: "tok",
      });
      expect(out.status).toBe(0);
      expect(out.stderr).toContain("skills: not installed (403)");
    } finally {
      server.stop(true);
    }
  });
});

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
      PROJECT_OS_MCP_JSON: piMcpJson("https://tunnel.example/mcp", "mcp-token-t1"),
      PROJECT_OS_MODEL: "openrouter/m",
      PROJECT_OS_PROMPT: workerSessionStart("daytona-t1"),
      // The session fetches its ticket's skills with its own token, from the Coordinator.
      PROJECT_OS_SKILLS_URL: "https://tunnel.example/tickets/t1/skills",
      PROJECT_OS_SKILLS_TOKEN: "mcp-token-t1",
    });
    expect(JSON.parse(calls[0]!.env.PROJECT_OS_MCP_JSON!)).toEqual({
      mcpServers: {
        "project-os": {
          url: "https://tunnel.example/mcp",
          headers: { Authorization: "Bearer mcp-token-t1" },
          exposure: "direct",
        },
      },
    });
    // The token reaches Pi through the env, never the shell line.
    expect(calls[0]!.command).not.toContain("mcp-token-t1");
  });

  it("behind the credential proxy, hands the session the proxy and points git at it", async () => {
    const calls: Parameters<SandboxRunner["run"]>[0][] = [];
    const { launcher } = setup(
      async (input) => {
        calls.push(input);
        return { exitCode: 0, output: "" };
      },
      [],
      "https://tunnel.example/egress/",
    );
    await Effect.runPromise(launcher.launch(daytonaTicket));
    expect(calls[0]!.command).toBe(PROXIED_SESSION_COMMAND);
    expect(calls[0]!.command).toContain('url."$PROJECT_OS_EGRESS_URL/github-git/".insteadOf');
    expect(calls[0]!.env).toMatchObject({
      PROJECT_OS_EGRESS_URL: "https://tunnel.example/egress",
      PROJECT_OS_EGRESS_TOKEN: "mcp-token-t1",
      PROJECT_OS_PROMPT: workerSessionStart("daytona-t1", { credentialProxy: true }),
    });
    expect(calls[0]!.command).not.toContain("mcp-token-t1");
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
        mcpToken: "mcp-token-t2",
      }),
    );
    await settle();
    expect(ran).toEqual(["cloudflare"]);
    expect(logs).toEqual([
      "cloudflare: launching cloudflare-t2 for ticket t2",
      "cloudflare: cloudflare-t2 finished",
    ]);
  });

  it("reports its providers as the pool, in order, with caps and session timeout", async () => {
    const { launcher } = setup(ok, [
      { workerType: "cloudflare_pi", runner: { run: ok }, maxConcurrent: 3 },
    ]);
    expect(await Effect.runPromise(launcher.pool)).toEqual([
      { workerType: "daytona_pi", sessionTimeoutSeconds: 1800 },
      { workerType: "cloudflare_pi", maxConcurrent: 3, sessionTimeoutSeconds: 1800 },
    ]);
  });

  it("fails the launch for worker types outside the pool, without running anything", async () => {
    let ran = false;
    const { launcher } = setup(async () => {
      ran = true;
      return { exitCode: 0, output: "" };
    });
    const fails = (input: Parameters<typeof launcher.launch>[0]) =>
      Effect.runPromise(Effect.flip(launcher.launch(input)));
    const local = await fails({
      ticketId: "t1",
      workerType: "local",
      workerId: "w",
      mcpToken: "m",
    });
    const unpooled = await fails({
      ticketId: "t1",
      workerType: "cloudflare_pi",
      workerId: "cloudflare-t1",
      mcpToken: "mcp-token-t1",
    });
    expect([local._tag, unpooled._tag]).toEqual(["LaunchFailed", "LaunchFailed"]);
    expect(ran).toBe(false);
  });

  it("fails the launch when the runner throws on kickoff, Error or not", async () => {
    const { launcher: boom } = setup(() => {
      throw new Error("no runner");
    });
    const { launcher: odd } = setup(() => {
      throw "weird";
    });
    expect((await Effect.runPromise(Effect.flip(boom.launch(daytonaTicket)))).message).toBe(
      "no runner",
    );
    expect((await Effect.runPromise(Effect.flip(odd.launch(daytonaTicket)))).message).toBe("weird");
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
