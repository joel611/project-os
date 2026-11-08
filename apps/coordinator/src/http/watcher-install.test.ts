import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { installLine, installScript, shellQuote } from "./watcher-install.ts";

const SERVER = "https://coord.example.com";
let dir: string;
let bin: string;
let home: string;
let log: string;

const stub = (name: string, body = "exit 0") => {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "watcher-install-"));
  bin = join(dir, "bin");
  home = join(dir, "home");
  log = join(dir, "log");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(log, "");
  stub("project-os-watcher", `echo "watcher $*" >> "${log}"`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a generated script under sh with only the stub CLIs (plus system tools and bun) on PATH. */
const run = (
  script: string,
  args: string[],
  { answers, agents = [] }: { answers?: string; agents?: string[] } = {},
) => {
  for (const agent of agents) stub(agent);
  const tty = join(dir, "tty");
  if (answers !== undefined) writeFileSync(tty, answers);
  const result = spawnSync("sh", ["-c", script, "sh", ...args], {
    encoding: "utf8",
    env: {
      HOME: home,
      LOG: log,
      PATH: `${bin}:/usr/bin:/bin`,
      PROJECT_OS_INSTALL_TTY: answers === undefined ? join(dir, "no-tty") : tty,
    },
  });
  return { ...result, log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
};

const install = installScript({ server: SERVER, installCommand: 'echo install >> "$LOG"' });

describe("reply lines", () => {
  it("fetches the scripts from the Coordinator and quotes what needs it", () => {
    const config = { server: `${SERVER}/` };
    expect(installLine(config, "abc")).toBe(
      "curl -fsSL https://coord.example.com/watcher/install.sh | sh -s -- abc",
    );
    expect(installLine(config, "abc", "my laptop")).toBe(
      "curl -fsSL https://coord.example.com/watcher/install.sh | sh -s -- abc --name 'my laptop'",
    );
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("defaults to the bun global install", () => {
    expect(installScript({ server: SERVER })).toContain("\nbun install -g @project-os/watcher\n");
  });
});

describe("install script", () => {
  it("takes --agent, --model and --name without asking, installs, then registers", () => {
    const r = run(install, ["abc", "--name", "my box", "--agent", "codex", "--model", "gpt-5"], {
      agents: ["codex"],
    });
    expect(r.status).toBe(0);
    expect(r.log).toEqual([
      "install",
      `watcher register abc --server ${SERVER} --agent codex --name my box --model gpt-5`,
    ]);
  });

  it("lists the agents it finds, asks which and which model, and uses the answers", () => {
    const r = run(install, ["abc"], { agents: ["claude", "codex"], answers: "2\ngpt-5\n" });
    expect(r.stdout).toContain("1) claude");
    expect(r.stdout).toContain("2) codex");
    expect(r.stderr).toContain("Which agent");
    expect(r.stderr).toContain("Model for codex");
    expect(r.log.at(-1)).toBe(
      `watcher register abc --server ${SERVER} --agent codex --model gpt-5`,
    );
  });

  it("takes an agent by name, and Enter for the defaults: first agent, no --model", () => {
    const byName = run(install, ["abc"], { agents: ["claude", "pi"], answers: "pi\n\n" });
    expect(byName.log.at(-1)).toBe(`watcher register abc --server ${SERVER} --agent pi`);
    const defaults = run(install, ["abc"], { agents: ["claude", "pi"], answers: "\n\n" });
    expect(defaults.log.at(-1)).toBe(`watcher register abc --server ${SERVER} --agent claude`);
  });

  it("stops on an answer that isn't one of the agents found", () => {
    const r = run(install, ["abc"], { agents: ["claude"], answers: "7\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not a choice: 7");
    expect(r.log).toEqual([]);
  });

  it("uses the only agent found when there is no terminal to ask on", () => {
    const r = run(install, ["abc"], { agents: ["pi"] });
    expect(r.status).toBe(0);
    expect(r.log.at(-1)).toBe(`watcher register abc --server ${SERVER} --agent pi`);
  });

  it("refuses to guess between several agents without a terminal", () => {
    const r = run(install, ["abc"], { agents: ["claude", "pi"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--agent <name>");
    expect(r.log).toEqual([]);
  });

  it("says when no agent CLI is installed", () => {
    const r = run(install, ["abc"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No agent CLI found");
    expect(r.log).toEqual([]);
  });

  it("warns when --agent names a CLI that isn't installed yet, but goes on", () => {
    const r = run(install, ["abc", "--agent", "pi"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("pi isn't installed");
  });

  it("rejects a missing code, an unknown agent, a flag without a value, and unknown flags", () => {
    expect(run(install, []).stderr).toContain("Usage:");
    expect(run(install, ["abc", "--agent", "gemini"]).stderr).toContain("--agent must be");
    expect(run(install, ["abc", "--model"]).stderr).toContain("--model needs a value");
    expect(run(install, ["abc", "--force"]).stderr).toContain("Unknown option --force");
    for (const r of [run(install, []), run(install, ["abc", "--force"])]) {
      expect(r.status).toBe(2);
      expect(r.log).toEqual([]);
    }
  });
});
