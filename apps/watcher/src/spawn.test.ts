import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { AGENTS, CODEX_TOKEN_ENV } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";
import type { McpClient } from "./poll.ts";
import { bunSpawner, type SkillsIo, type SpawnAcp, type SpawnerIo } from "./spawn.ts";
import { strToU8, zipSync } from "fflate";
import { collectLogger } from "./logger.ts";
import type { RunLogIo } from "./run-log.ts";
import type { SpawnProcess } from "./spawn.ts";
import type { Git } from "./workspace.ts";

/** Real folders: each test's tickets get their own workspace under here. */
const ROOT = mkdtempSync(join(tmpdir(), "spawn-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let roots = 0;
const T1 = { id: "t1", projectId: "p1" };

/** A Coordinator whose project has no sources. */
const noSources: McpClient = {
  callTool: async (name) => {
    if (name === "project_sources_list") return { sources: [] };
    throw new Error(`unexpected ${name}`);
  },
};
const noGit: Git = async () => {
  throw new Error("git must not run");
};

const config: WatcherConfig = {
  mcpUrl: "http://coord:8080/mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  secret: "s3cret",
  skills: true,
  runLog: true,
  piAcp: false,
  piAcpCommand: ["pi-acp"],
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
    mcp: noSources,
    workspaces: { root: join(ROOT, `ws-${++roots}`), git: noGit },
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
  it("spawns the configured agent with the worker id in the prompt", async () => {
    const { io } = fakeIo();
    const { code, seen } = await run(config, io);
    expect(code).toBe(7);
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

describe("skills for a ticket", () => {
  const zipOf = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  type Archive = { set: string; zip: Uint8Array };
  const bundle: Archive = {
    set: "development",
    zip: zipOf({
      "tdd/SKILL.md": "# tdd",
      "tdd/examples/a.ts": "export {}",
      // Anything that climbs out of the skill's folder, or has an unsafe name, is dropped.
      "tdd/../escape.md": "no",
      "tdd/a\\b.md": "no",
      "../bad/SKILL.md": "no",
      "tdd/": "",
    }),
  };

  const skillsIo = (answer: () => Promise<Archive | undefined>) => {
    const written: Record<string, string> = {};
    const removed: string[] = [];
    const urls: Array<[string, string]> = [];
    const skills: SkillsIo = {
      fetchArchive: (url, secret) => {
        urls.push([url, secret]);
        return answer();
      },
      fetchTaskType: async () => undefined,
      makeDir: () => "/tmp/sk",
      writeFile: (path, contents) => {
        written[path] = contents;
      },
      removeDir: (path) => {
        removed.push(path);
      },
    };
    const logs: string[] = [];
    const { io } = fakeIo();
    return {
      io: { ...io, skills, logger: collectLogger(logs) },
      written,
      removed,
      urls,
      logs,
    };
  };

  const runTicket = async (cfg: WatcherConfig, io: SpawnerIo, ticketId?: string) => {
    let cmd: string[] = [];
    const spawner = bunSpawner(
      cfg,
      (c) => {
        cmd = c;
        return { exited: Promise.resolve(0) };
      },
      io,
    );
    await spawner.spawn(ticketId === undefined ? undefined : { id: ticketId, projectId: "p1" });
    return cmd;
  };

  it("writes the set under a session folder for the agent, then removes it", async () => {
    const s = skillsIo(async () => bundle);
    const cmd = await runTicket(config, s.io, "t1");
    expect(s.urls).toEqual([["http://coord:8080/tickets/t1/skills", "s3cret"]]);
    expect(s.written).toEqual({
      "/tmp/sk/.claude/skills/tdd/SKILL.md": "# tdd",
      "/tmp/sk/.claude/skills/tdd/examples/a.ts": "export {}",
    });
    expect(cmd[cmd.indexOf("--add-dir") + 1]).toBe("/tmp/sk");
    expect(cmd[2]).toContain("This session is for ticket `t1`");
    expect(s.removed).toEqual(["/tmp/sk"]);
    expect(s.logs).toContain('skills: skipped unsafe path "tdd/../escape.md"');
    expect(s.logs.some((l) => l.includes('installed 1 skill(s) from "development"'))).toBe(true);
  });

  it("puts the ticket's task type instructions into the prompt", async () => {
    const s = skillsIo(async () => bundle);
    const asked: Array<[string, string]> = [];
    const io: SpawnerIo = {
      ...s.io,
      skills: {
        ...s.io.skills!,
        fetchTaskType: async (url, secret) => {
          asked.push([url, secret]);
          return { name: "development", instructions: "Start with the tdd skill." };
        },
      },
    };
    const cmd = await runTicket(config, io, "t1");
    expect(asked).toEqual([["http://coord:8080/tickets/t1/task-type", "s3cret"]]);
    expect(cmd[2]).toContain('Task type "development"');
    expect(cmd[2]).toContain("Start with the tdd skill.");
  });

  it("starts the session without instructions when the task type can't be fetched", async () => {
    const s = skillsIo(async () => bundle);
    const io: SpawnerIo = {
      ...s.io,
      skills: {
        ...s.io.skills!,
        fetchTaskType: async () => {
          throw new Error("down");
        },
      },
    };
    const cmd = await runTicket(config, io, "t1");
    expect(cmd[2]).not.toContain("Task type");
    expect(s.logs.some((l) => l.includes("task type: fetch failed: down"))).toBe(true);
  });

  it("skips the task type when skills are turned off", async () => {
    const s = skillsIo(async () => bundle);
    let asked = false;
    const io: SpawnerIo = {
      ...s.io,
      skills: {
        ...s.io.skills!,
        fetchTaskType: async () => {
          asked = true;
          return undefined;
        },
      },
    };
    await runTicket({ ...config, skills: false }, io, "t1");
    expect(asked).toBe(false);
  });

  it("lays skills out the way Pi wants them", async () => {
    const s = skillsIo(async () => bundle);
    const cmd = await runTicket({ ...config, agent: "pi" }, s.io, "t1");
    expect(Object.keys(s.written)).toContain("/tmp/sk/skills/tdd/SKILL.md");
    expect(cmd).toContain("/tmp/sk/skills/tdd");
  });

  it("removes the folder even when the agent fails to start", async () => {
    const s = skillsIo(async () => bundle);
    const spawner = bunSpawner(
      config,
      () => {
        throw new Error("no such binary");
      },
      s.io,
    );
    await expect(spawner.spawn(T1)).rejects.toThrow("no such binary");
    expect(s.removed).toEqual(["/tmp/sk"]);
  });

  it.each([
    ["can't be fetched", async () => undefined],
    [
      "fetch throws",
      async (): Promise<Archive | undefined> => {
        throw new Error("offline");
      },
    ],
  ])("starts without skills when the ticket %s", async (_why, answer) => {
    const s = skillsIo(answer);
    const cmd = await runTicket(config, s.io, "t1");
    expect(cmd).not.toContain("--add-dir");
    expect(s.written).toEqual({});
    expect(s.removed).toEqual([]);
  });

  it.each([
    ["every skill name is unsafe", zipOf({ "../bad/SKILL.md": "x" })],
    ["the zip is empty", zipOf({})],
    ["the zip is malformed", strToU8("not a zip")],
  ])("starts without skills when %s", async (_why, zip) => {
    const s = skillsIo(async () => ({ set: "n", zip }));
    const cmd = await runTicket(config, s.io, "t1");
    expect(cmd).not.toContain("--add-dir");
    // The folder made for it is cleaned up.
    expect(s.removed).toEqual(["/tmp/sk"]);
  });

  it("skips skills when turned off, when there is no ticket, or the agent can't load them", async () => {
    const off = skillsIo(async () => bundle);
    await runTicket({ ...config, skills: false }, off.io, "t1");
    expect(off.urls).toEqual([]);
    const none = skillsIo(async () => bundle);
    const cmd = await runTicket(config, none.io);
    expect(none.urls).toEqual([]);
    expect(cmd[2]).not.toContain("This session is for ticket");
    const codex = skillsIo(async () => bundle);
    await runTicket({ ...config, agent: "codex" }, codex.io, "t1");
    expect(codex.urls).toEqual([]);
    // A device wired without skill IO (old callers) still starts sessions.
    const { io } = fakeIo();
    expect(await runTicket(config, io, "t1")).toContain("claude");
  });
});

describe("a ticket's workspace", () => {
  const TOKEN = "gho_person_token_123";
  /** A Coordinator whose project links `acme/web` as `web` and a Drive folder. */
  const coordinator = (options: { token?: () => unknown; sources?: () => unknown } = {}) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const mcp: McpClient = {
      callTool: async (name, args) => {
        calls.push([name, args]);
        if (name === "project_sources_list") {
          return (
            options.sources?.() ?? {
              sources: [
                { alias: "web", type: "github_repo", externalId: "acme/web" },
                { alias: "docs", type: "google_drive_folder", externalId: "1AbCdEfGhIjK" },
              ],
            }
          );
        }
        if (name === "user_token") return options.token?.() ?? { accessToken: TOKEN };
        throw new Error(`unexpected ${name}`);
      },
    };
    return { mcp, calls };
  };
  /** Clones `public` repos without auth, and the rest only with the person's token. */
  const git = (open: boolean) => {
    const argv: string[][] = [];
    const run: Git = async (args, { env }) => {
      argv.push([...args]);
      const authed = Object.values(env).some((v) => v?.includes(btoa(`x-access-token:${TOKEN}`)));
      if (!open && !authed) return { code: 128, stderr: "fatal: Repository not found.\n" };
      mkdirSync(args.at(-1)!, { recursive: true });
      writeFileSync(join(args.at(-1)!, "README.md"), "web");
      return { code: 0, stderr: "" };
    };
    return { run, argv };
  };
  const launch = async (mcp: McpClient, gitRun: Git) => {
    const { io } = fakeIo();
    let seen: { cmd: string[]; cwd: string } | undefined;
    const spawner = bunSpawner(
      config,
      (cmd, options) => {
        seen = { cmd, cwd: options.cwd };
        return { exited: Promise.resolve(0) };
      },
      { ...io, mcp, workspaces: { root: io.workspaces.root, git: gitRun } },
    );
    expect(await spawner.spawn(T1)).toBe(0);
    return { ...seen!, root: io.workspaces.root, prompt: seen!.cmd[2]! };
  };

  it("starts the agent in the project's only repo, cloned without asking for a token", async () => {
    const { mcp, calls } = coordinator();
    const g = git(true);
    const { cwd, prompt, root } = await launch(mcp, g.run);
    expect(cwd).toBe(join(root, "t1", "web"));
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("web");
    expect(calls).toEqual([["project_sources_list", { projectId: "p1" }]]);
    expect(prompt).toContain(`- \`web\` (\`acme/web\`): \`${join(root, "t1", "web")}\``);
    expect(prompt).toContain(`this session starts in \`${cwd}\``);
  });

  it("clones a private repo with the person's token, which never reaches argv or the prompt", async () => {
    const { mcp, calls } = coordinator();
    const g = git(false);
    const { cwd, prompt, root } = await launch(mcp, g.run);
    expect(cwd).toBe(join(root, "t1", "web"));
    expect(calls.map(([name]) => name)).toEqual(["project_sources_list", "user_token"]);
    expect(calls[1]![1]).toEqual({ ticketId: "t1", provider: "github" });
    expect(g.argv).toHaveLength(2);
    expect(g.argv.flat().join(" ")).not.toContain(TOKEN);
    expect(prompt).not.toContain(TOKEN);
  });

  it("still starts the session, in the ticket's folder, when the repo can't be cloned", async () => {
    const { mcp } = coordinator({
      token: () => {
        throw new Error('MCP user_token: {"_tag":"NotConnected"}');
      },
    });
    const { cwd, prompt, root } = await launch(mcp, git(false).run);
    expect(cwd).toBe(join(root, "t1"));
    expect(prompt).toContain("could not be checked out");
    expect(prompt).toMatch(/- `web` \(`acme\/web`\): .*Repository not found.*NotConnected/);
  });

  it("reports a user_token answer that holds no token", async () => {
    const { mcp } = coordinator({ token: () => ({}) });
    const g = git(false);
    const { prompt } = await launch(mcp, g.run);
    expect(g.argv).toHaveLength(1);
    expect(prompt).toContain("user_token returned no token");
  });

  it("still starts the session when the project's sources can't be listed", async () => {
    const { mcp } = coordinator({
      sources: () => {
        throw new Error("MCP project_sources_list: HTTP 500");
      },
    });
    const { cwd, prompt, root } = await launch(mcp, noGit);
    expect(cwd).toBe(join(root, "t1"));
    expect(prompt).toContain("could not be listed (MCP project_sources_list: HTTP 500)");
  });
});

describe("recording a session", () => {
  const posted: Array<{
    url: string;
    events: Array<{ type: string; text: string; tool?: string }>;
    model?: string;
    finished?: unknown;
  }> = [];
  const shown: string[] = [];
  const runLog: RunLogIo = {
    post: async (url, _secret, upload) => {
      posted.push({
        url,
        events: [...upload.events],
        ...(upload.model && { model: upload.model }),
        ...(upload.finished && { finished: upload.finished }),
      });
      return { ok: true, nextSeq: upload.seq + 1 };
    },
    spool: { write: () => {}, list: () => [], remove: () => {} },
    newRunId: () => "run-00000001",
    now: () => new Date("2026-11-04T00:00:00.000Z"),
    secrets: [],
    flushEveryMs: 3_600_000,
    sleep: async () => {},
    terminal: { out: (t) => void shown.push(t), err: (t) => void shown.push(`ERR ${t}`) },
  };
  const record = async (
    cfg: WatcherConfig,
    proc: (cmd: string[]) => ReturnType<SpawnProcess>,
    ticketId: string | null = "t1",
  ) => {
    posted.length = 0;
    shown.length = 0;
    const { io } = fakeIo();
    const seen: string[][] = [];
    const spawner = bunSpawner(cfg, (cmd) => (seen.push(cmd), proc(cmd)), { ...io, runLog });
    const code = await spawner.spawn(
      ticketId === null ? undefined : { id: ticketId, projectId: "p1" },
    );
    return { code, seen: seen[0]! };
  };
  const text = (value: string) => new Response(value).body!;

  it("pipes a plain-text agent's lines, with the model, and shows them as they came", async () => {
    const { code, seen } = await record({ ...config, agent: "pi", model: "m1" }, () => ({
      exited: Promise.resolve(0),
      stdout: text("first\nlast without newline"),
      stderr: text("warn\n"),
    }));
    expect(code).toBe(0);
    expect(seen).not.toContain("--output-format");
    expect(posted[0]).toMatchObject({ url: "http://coord:8080/tickets/t1/runs", model: "m1" });
    const texts = posted[0]!.events.map((e) => e.text);
    expect(texts.at(-1)).toBe("pi exited with code 0.");
    expect(texts.slice(0, -1).sort()).toEqual(["first", "last without newline", "warn"]);
    expect(shown.sort()).toEqual(["ERR warn\n", "first\n", "last without newline\n"]);
  });

  it("asks Claude Code for its event stream, and keeps a process that has no pipes", async () => {
    const { seen } = await record(config, () => ({ exited: Promise.resolve(3) }));
    expect(seen).toContain("stream-json");
    expect(posted[0]!.events.at(-1)).toMatchObject({
      type: "error",
      text: "claude exited with code 3.",
    });
    expect(posted[0]!.finished).toEqual({ exitCode: 3 });
  });

  it("does not record without a ticket, or when the device turned it off", async () => {
    await record(config, () => ({ exited: Promise.resolve(0) }), null);
    expect(posted).toEqual([]);
    await record({ ...config, runLog: false }, () => ({ exited: Promise.resolve(0) }));
    expect(posted).toEqual([]);
  });
});

describe("Pi over ACP", () => {
  const acpConfig: WatcherConfig = {
    ...config,
    agent: "pi",
    model: "openrouter/m",
    piAcp: true,
    piAcpCommand: ["bun", "pi-acp.ts"],
  };

  /** A fake ACP agent behind the process the spawner starts; it records how it was started. */
  const fakeAcp = () => {
    const started: Array<{ cmd: string[]; env: Record<string, string | undefined>; cwd: string }> =
      [];
    const sessionCwds: string[] = [];
    const spawnAcp: SpawnAcp = (cmd, options) => {
      started.push({ cmd, env: options.env, cwd: options.cwd });
      const toAgent = new TransformStream<Uint8Array>();
      const fromAgent = new TransformStream<Uint8Array>();
      const connection = agent()
        .onRequest(methods.agent.initialize, () => ({
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
        }))
        .onRequest(methods.agent.session.new, ({ params }) => {
          sessionCwds.push(params.cwd);
          return { sessionId: "s1" };
        })
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: "end_turn" }))
        .connect(ndJsonStream(fromAgent.writable, toAgent.readable));
      return {
        exited: connection.closed.then(() => 0),
        stdin: toAgent.writable,
        stdout: fromAgent.readable,
        stderr: new Response("pi warning\n").body,
        kill: () => connection.close(),
      };
    };
    return { spawnAcp, started, sessionCwds };
  };

  it("starts the ACP program with the model and the session's skills, and prints to the terminal", async () => {
    const { spawnAcp, started, sessionCwds } = fakeAcp();
    const { io } = fakeIo();
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      out.push(String(text));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const spawner = bunSpawner(
        acpConfig,
        () => {
          throw new Error("must not run Pi as a CLI");
        },
        {
          ...io,
          spawnAcp,
          skills: {
            fetchArchive: async () => ({
              set: "dev",
              zip: zipSync({ "tdd/SKILL.md": strToU8("# tdd") }),
            }),
            fetchTaskType: async () => undefined,
            makeDir: () => "/tmp/sk",
            writeFile: () => {},
            removeDir: () => {},
          },
        },
      );
      expect(await spawner.spawn(T1)).toBe(0);
      expect(started[0]!.cmd).toEqual(["bun", "pi-acp.ts"]);
      // The program and its session both start in the ticket's folder.
      expect(started[0]!.cwd).toBe(join(io.workspaces.root, "t1"));
      expect(sessionCwds).toEqual([join(io.workspaces.root, "t1")]);
      expect(started[0]!.env).toMatchObject({
        PATH: "/bin",
        PI_ACP_MODEL: "openrouter/m",
        PI_ACP_SKILL_PATHS: "/tmp/sk/skills/tdd",
      });
      expect(out.join("")).toContain("Session finished (end_turn).");
      expect(err).toHaveBeenCalledWith("pi warning\n");
    } finally {
      write.mockRestore();
      err.mockRestore();
    }
  });

  it("runs Pi as a CLI when the device cannot start ACP programs", async () => {
    const { io } = fakeIo();
    const { seen } = await run(acpConfig, io);
    expect(seen.cmd[0]).toBe("pi");
  });

  it("runs other agents as usual even with the flag on", async () => {
    const { spawnAcp, started } = fakeAcp();
    const { io } = fakeIo();
    const { seen } = await run({ ...acpConfig, agent: "claude" }, { ...io, spawnAcp });
    expect(seen.cmd[0]).toBe("claude");
    expect(started).toEqual([]);
  });
});
