import { describe, expect, it } from "vite-plus/test";
import { AGENTS, CODEX_TOKEN_ENV } from "./agents.ts";
import type { WatcherConfig } from "./config.ts";
import { bunSpawner, skillsUrl, type SkillsIo, type SpawnerIo } from "./spawn.ts";
import { strToU8, zipSync } from "fflate";
import { collectLogger } from "./logger.ts";

const config: WatcherConfig = {
  mcpUrl: "http://coord:8080/mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/work",
  secret: "s3cret",
  skills: true,
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
    await spawner.spawn(ticketId);
    return cmd;
  };

  it("finds the skills next to the MCP endpoint", () => {
    expect(skillsUrl("http://coord:8080/mcp", "t 1")).toBe(
      "http://coord:8080/tickets/t%201/skills",
    );
    expect(skillsUrl("http://coord:8080/mcp/", "t1")).toBe("http://coord:8080/tickets/t1/skills");
  });

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
    await expect(spawner.spawn("t1")).rejects.toThrow("no such binary");
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
