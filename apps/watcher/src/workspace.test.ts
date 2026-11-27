import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeGithub } from "./fake-github.ts";
import type { Git } from "./git.ts";
import { createWorkspaces, type RepoSource } from "./workspace.ts";

const ADA = "gho_ada_token_123";
const BOB = "gho_bob_token_456";
const basic = (token: string) => btoa(`x-access-token:${token}`);
const WEB: RepoSource = { alias: "web", repo: "acme/web" };

let base: string;
let root: string;
let gh: ReturnType<typeof fakeGithub>;
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "workspace-test-"));
  root = join(base, "workspaces");
  gh = fakeGithub(join(base, "github"));
  mkdirSync(join(base, "github"));
  await gh.push("acme/web", { "README.md": "v1" }, "first");
});
afterEach(() => {
  gh.stop();
  rmSync(base, { recursive: true, force: true });
});

const tokens = (answer: () => Promise<string>) => {
  let asked = 0;
  return {
    githubToken: () => {
      asked++;
      return answer();
    },
    asked: () => asked,
  };
};
const as = (token: string) => tokens(async () => token).githubToken;
const notConnected = async (): Promise<string> => {
  throw new Error('MCP user_token: {"_tag":"NotConnected"}');
};

const workspaces = (git: Git = gh.git, env: Record<string, string | undefined> = {}) =>
  createWorkspaces({ root, git, env: { PATH: process.env.PATH, ...env } });
const prepare = (
  ticketId: string,
  repos: RepoSource[] = [WEB],
  githubToken = as(ADA),
  ws = workspaces(),
) => ws.prepare({ ticketId, repos, githubToken });

const worktree = (ticketId: string, alias = "web") => join(root, "tickets", ticketId, alias);
const readme = (ticketId: string) => readFileSync(join(worktree(ticketId), "README.md"), "utf8");
const commands = () => gh.calls.map((c) => c.args.filter((a) => !a.startsWith("-"))[0]);

describe("preparing a ticket's workspace", () => {
  it("clones each repo once and gives every ticket its own worktree on its own branch", async () => {
    const ws = await prepare("t1");
    const path = worktree("t1");
    expect(ws).toEqual({
      cwd: path,
      checkouts: [{ alias: "web", repo: "acme/web", path, branch: "ticket/t1" }],
      failed: [],
    });
    expect(readme("t1")).toBe("v1");
    expect(await gh.sh(["branch", "--show-current"], path)).toBe("ticket/t1");
    // Not tracking the default branch, so a plain `git push` can't land on it.
    await expect(gh.sh(["rev-parse", "--abbrev-ref", "@{u}"], path)).rejects.toThrow();

    // The next ticket starts from the default branch as GitHub has it now.
    await gh.push("acme/web", { "README.md": "v2" });
    await prepare("t2");
    expect(readme("t2")).toBe("v2");
    expect(readme("t1")).toBe("v1");
    expect(commands().filter((c) => c === "clone")).toHaveLength(1);
    expect(readdirSync(join(root, "repos", "acme"))).toEqual(["web"]);
    expect(readdirSync(join(root, "repos", ".partial", "acme"))).toEqual([]);
    expect(readdirSync(join(root, "tickets", "t2"))).toEqual(["web"]);
  });

  it("starts in the ticket's folder with several repos, and an empty one with none", async () => {
    await gh.push("acme/api", { "README.md": "api" });
    const two = await prepare("t1", [WEB, { alias: "api", repo: "acme/api" }]);
    expect(two.cwd).toBe(join(root, "tickets", "t1"));
    expect(two.checkouts.map((c) => c.alias)).toEqual(["web", "api"]);

    const none = await prepare("t2", []);
    expect(none).toEqual({ cwd: join(root, "tickets", "t2"), checkouts: [], failed: [] });
  });

  it("reuses a worktree as it is, without fetching, so a reopened ticket keeps its work", async () => {
    await prepare("t1");
    const notes = join(worktree("t1"), "notes.txt");
    writeFileSync(notes, "half done");
    await gh.push("acme/web", { "README.md": "v2" });
    const before = gh.calls.length;

    const again = await prepare("t1");
    expect(gh.calls).toHaveLength(before);
    expect(again.cwd).toBe(worktree("t1"));
    expect(readme("t1")).toBe("v1");
    expect(readFileSync(notes, "utf8")).toBe("half done");
  });

  it("keeps the ticket's branch, and makes the worktree again when its folder was deleted", async () => {
    await prepare("t1");
    writeFileSync(join(worktree("t1"), "fix.txt"), "fixed");
    await gh.sh(["add", "fix.txt"], worktree("t1"));
    await gh.sh(["commit", "--quiet", "-m", "the fix"], worktree("t1"));
    rmSync(worktree("t1"), { recursive: true, force: true });

    const ws = await prepare("t1");
    expect(ws.failed).toEqual([]);
    expect(readFileSync(join(worktree("t1"), "fix.txt"), "utf8")).toBe("fixed");
    expect(await gh.sh(["log", "-1", "--format=%s"], worktree("t1"))).toBe("the fix");
  });

  it("replaces a clone or worktree a crash cut short", async () => {
    mkdirSync(join(root, "repos", ".partial", "acme", "web", "junk"), { recursive: true });
    await prepare("t1");
    expect(readme("t1")).toBe("v1");

    mkdirSync(join(root, "tickets", "t2", ".web.partial", "junk"), { recursive: true });
    await prepare("t2");
    expect(readdirSync(join(root, "tickets", "t2"))).toEqual(["web"]);
  });

  it("serializes git in one base clone across sessions and cleanup", async () => {
    let active = 0;
    let most = 0;
    const counting: Git = async (args, options) => {
      most = Math.max(most, ++active);
      try {
        return await gh.git(args, options);
      } finally {
        active--;
      }
    };
    const ws = workspaces(counting);
    await Promise.all(["t1", "t2", "t3"].map((id) => prepare(id, [WEB], as(ADA), ws)));
    expect(commands().filter((c) => c === "clone")).toHaveLength(1);
    expect(["t1", "t2", "t3"].map(readme)).toEqual(["v1", "v1", "v1"]);

    await Promise.all([ws.cleanup("t1"), prepare("t4", [WEB], as(ADA), ws), ws.cleanup("t2")]);
    expect(most).toBe(1);
    expect(ws.ticketIds().sort()).toEqual(["t3", "t4"]);
  });

  it("lets the next session use a repo after one failed outright", async () => {
    const ws = workspaces();
    // A file where the owner's folder should be: making the clone's folder throws.
    mkdirSync(join(root, "repos"), { recursive: true });
    writeFileSync(join(root, "repos", "acme"), "");
    await expect(prepare("t1", [WEB], as(ADA), ws)).rejects.toThrow();
    rmSync(join(root, "repos", "acme"));
    expect((await prepare("t2", [WEB], as(ADA), ws)).failed).toEqual([]);
  });

  it("asks for the person's token only when the anonymous attempt fails, and at most once", async () => {
    await gh.push("acme/api", { "README.md": "api" });
    await gh.push("acme/ops", { "README.md": "ops" });
    gh.restrict("acme/api", [ADA]);
    gh.restrict("acme/ops", [ADA]);
    const t = tokens(async () => ADA);
    const ws = await prepare(
      "t1",
      [WEB, { alias: "api", repo: "acme/api" }, { alias: "ops", repo: "acme/ops" }],
      t.githubToken,
    );
    expect(ws.failed).toEqual([]);
    expect(t.asked()).toBe(1);
    const clones = gh.calls.filter((c) => c.args[0] === "clone");
    // web: anonymous. api and ops: anonymous, then with the token.
    expect(clones.map((c) => c.args.at(-2))).toEqual([
      "https://github.com/acme/web.git",
      "https://github.com/acme/api.git",
      "https://github.com/acme/api.git",
      "https://github.com/acme/ops.git",
      "https://github.com/acme/ops.git",
    ]);
    expect(JSON.stringify(clones[1]!.env)).not.toContain(basic(ADA));
    expect(JSON.stringify(clones[2]!.env)).toContain(basic(ADA));
    for (const call of gh.calls) expect(call.args.join(" ")).not.toContain(ADA);
    // Only clone and fetch reach GitHub, so only they ever carry the token.
    for (const call of gh.calls.filter((c) => !["clone", "fetch"].includes(c.args[0]!))) {
      expect(JSON.stringify(call.env)).not.toContain(basic(ADA));
    }
    expect(
      await gh.sh(["config", "--list", "--local"], join(root, "repos", "acme", "api")),
    ).not.toContain(basic(ADA));
  });

  it("gives no files to a person who can't read the repo, though another's token cloned it", async () => {
    gh.restrict("acme/web", [ADA]);
    expect((await prepare("t1", [WEB], as(ADA))).failed).toEqual([]);

    for (const [ticketId, githubToken] of [
      ["t2", as(BOB)],
      ["t3", notConnected],
    ] as const) {
      const ws = await prepare(ticketId, [WEB], githubToken);
      expect(ws.checkouts).toEqual([]);
      expect(ws.failed).toEqual([
        {
          alias: "web",
          repo: "acme/web",
          reason: expect.stringMatching(/^git fetch exited with 128: .*not found/),
        },
      ]);
      expect(ws.cwd).toBe(join(root, "tickets", ticketId));
      expect(readdirSync(join(root, "tickets", ticketId))).toEqual([]);
    }
    expect((await prepare("t3", [WEB], notConnected)).failed[0]!.reason).toMatch(
      /no GitHub token.*NotConnected/,
    );
  });

  it("gives up on a clone that times out, without a token retry or a partial folder", async () => {
    gh.stall("acme/web");
    const t = tokens(async () => ADA);
    const ws = await prepare("t1", [WEB], t.githubToken);
    expect(ws.failed).toEqual([
      { alias: "web", repo: "acme/web", reason: "git clone timed out after 1s" },
    ]);
    expect(t.asked()).toBe(0);
    expect(readdirSync(join(root, "repos", "acme"))).toEqual([]);
    expect(readdirSync(join(root, "repos", ".partial", "acme"))).toEqual([]);
  });

  it("gives up on a fetch that times out, and makes no worktree", async () => {
    await prepare("t1");
    gh.stall("acme/web");
    const t = tokens(async () => ADA);
    const ws = await prepare("t2", [WEB], t.githubToken);
    expect(ws.failed[0]!.reason).toBe("git fetch timed out after 1s");
    expect(t.asked()).toBe(0);
    expect(existsSync(worktree("t2"))).toBe(false);
  });

  it("keeps the token out of the reason when git prints it", async () => {
    // A git that refuses every networked command and echoes the auth header it was given.
    const echoing: Git = async (args, options) => {
      if (!["clone", "fetch"].includes(args[0]!)) return gh.git(args, options);
      const header = Object.values(options.env).find((v) => v?.startsWith("AUTHORIZATION"));
      return { code: 128, stdout: "", stderr: `fatal: bad header ${header} for ${ADA}\n` };
    };
    const ws = await prepare("t1", [WEB], as(ADA), workspaces(echoing));
    expect(ws.failed[0]!.reason).toBe(
      "git clone exited with 128: fatal: bad header AUTHORIZATION: basic *** for ***",
    );
    expect(ws.failed[0]!.reason).not.toContain(ADA);
    expect(ws.failed[0]!.reason).not.toContain(basic(ADA));
  });

  it("reports a step that fails, and says so when git prints nothing", async () => {
    await prepare("t1");
    const failing =
      (step: string, stderr = "fatal: no\n"): Git =>
      async (args, options) =>
        args[1] === step ? { code: 137, stdout: "", stderr } : gh.git(args, options);
    expect(
      (await prepare("t2", [WEB], as(ADA), workspaces(failing("move")))).failed[0]!.reason,
    ).toBe("git worktree move exited with 137: fatal: no");
    expect(
      (await prepare("t3", [WEB], as(ADA), workspaces(failing("add", "")))).failed[0]!.reason,
    ).toBe("git worktree add exited with 137: no output");
  });

  it.each(["../evil", "a/b", ".", "..", "", "-rf", "t1\n"])(
    "refuses ticket id %j, which would leave the workspaces folder",
    async (ticketId) => {
      await expect(prepare(ticketId)).rejects.toThrow(/unsafe ticket id/);
      expect(gh.calls).toEqual([]);
      expect(existsSync(root)).toBe(false);
    },
  );

  it("skips aliases and repos that would escape the ticket's folder or reach git as options", async () => {
    const ws = await prepare("t1", [
      { alias: "../web", repo: "acme/web" },
      { alias: "-c", repo: "acme/web" },
      { alias: ".git", repo: "acme/web" },
      { alias: "site", repo: "--upload-pack=touch /tmp/x" },
      { alias: "lab", repo: "gitlab.com/acme/web" },
      { alias: "web", repo: "https://github.com/Acme/Web" },
    ]);
    expect(ws.failed.map((f) => f.alias)).toEqual(["../web", "-c", ".git", "site", "lab"]);
    expect(ws.checkouts).toEqual([
      { alias: "web", repo: "acme/web", path: worktree("t1"), branch: "ticket/t1" },
    ]);
    expect(readdirSync(base).sort()).toEqual(["github", "workspaces"]);
  });
});

describe("git hardening", () => {
  it("runs git without this computer's credentials, config, prompts, or protocols", async () => {
    await prepare(
      "t1",
      [WEB],
      as(ADA),
      workspaces(gh.git, {
        HOME: "/home/owner",
        GIT_ASKPASS: "/usr/bin/owner-askpass",
        SSH_ASKPASS: "/usr/bin/owner-askpass",
        GIT_CONFIG_PARAMETERS: "'url.git@github.com:.insteadOf'='https://github.com/'",
        GIT_SSL_NO_VERIFY: "1",
        HTTPS_PROXY: "http://proxy:3128",
      }),
    );
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const { env } of gh.calls) {
      expect(env).toMatchObject({
        HTTPS_PROXY: "http://proxy:3128",
        HOME: "/dev/null",
        XDG_CONFIG_HOME: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "https",
      });
      expect(env).not.toHaveProperty("SSH_ASKPASS");
      expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
      expect(env).not.toHaveProperty("GIT_SSL_NO_VERIFY");
    }
  });

  it("forces its settings over the clone's own, with only the person's header for the exact URL", async () => {
    // Real git reads back the config a token fetch would run with.
    const url = "https://github.com/acme/web.git";
    const seen: string[] = [];
    const reading: Git = async (args, options) => {
      if (args[0] !== "fetch") return gh.git(args, options);
      const listed = await gh.git(["config", "--list", "--show-scope"], options);
      seen.push(listed.stdout);
      return { code: 128, stdout: "", stderr: "fatal: refused" };
    };
    await prepare("t1");
    await prepare("t2", [WEB], as(ADA), workspaces(reading, { HTTPS_PROXY: "http://proxy:3128" }));
    expect(seen).toHaveLength(2);
    const command = (listing: string) =>
      listing
        .split("\n")
        .filter((line) => line.startsWith("command\t"))
        .map((line) => line.slice(8));
    const forced = [
      "credential.helper=",
      "core.askpass=",
      "core.hookspath=/dev/null",
      "core.fsmonitor=false",
      "core.alternaterefscommand=true",
      "http.sslverify=true",
      `http.${url}.sslverify=true`,
      `http.${url}.followredirects=initial`,
      `http.${url}.proxy=http://proxy:3128`,
      `remote.${url}.proxy=http://proxy:3128`,
      `http.${url}.curloptresolve=`,
      `http.${url}.extraheader=`,
    ];
    expect(command(seen[0]!)).toEqual(forced);
    expect(command(seen[1]!)).toEqual([
      ...forced,
      `http.${url}.extraheader=AUTHORIZATION: basic ${basic(ADA)}`,
    ]);
  });

  it("runs no hook or fsmonitor an agent left in the shared clone", async () => {
    await prepare("t1");
    const clone = join(root, "repos", "acme", "web");
    const marker = join(base, "ran");
    const script = join(base, "hook.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0" >> ${marker}\nenv >> ${marker}\n`);
    chmodSync(script, 0o755);
    for (const hook of ["reference-transaction", "post-checkout", "pre-auto-gc"]) {
      writeFileSync(join(clone, ".git", "hooks", hook), readFileSync(script));
      chmodSync(join(clone, ".git", "hooks", hook), 0o755);
    }
    await gh.sh(["config", "core.hooksPath", join(clone, ".git", "hooks")], clone);
    await gh.sh(["config", "core.fsmonitor", script], clone);
    await gh.push("acme/web", { "README.md": "v2" });
    gh.restrict("acme/web", [ADA]);

    expect((await prepare("t2")).failed).toEqual([]);
    expect((await workspaces().cleanup("t2")).removed).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  it("won't fetch through a clone whose config an agent pointed elsewhere", async () => {
    await prepare("t1");
    const clone = join(root, "repos", "acme", "web");
    const url = "https://github.com/acme/web.git";
    for (const [key, value] of [
      [`url.https://github.com/evil/web.git.insteadOf`, url],
      [`remote.${url}.url`, "https://github.com/evil/web.git"],
    ]) {
      await gh.sh(["config", key!, value!], clone);
      const ws = await prepare("t2", [WEB], notConnected);
      expect(ws.failed[0]!.reason).toMatch(
        /^not fetched: the shared clone's git config redirects its URL/,
      );
      expect(ws.failed[0]!.reason).toContain(key!.toLowerCase());
      expect(existsSync(worktree("t2"))).toBe(false);
      await gh.sh(["config", "--unset", key!], clone);
    }
    expect(gh.calls.filter((c) => c.args[0] === "fetch")).toHaveLength(0);
  });
});

describe("cleaning up a ticket's workspace", () => {
  it("removes clean worktrees, the merged branch and the empty folder, keeping the clone", async () => {
    await prepare("t1");
    const ws = workspaces();
    expect(await ws.cleanup("t1")).toEqual({ removed: [worktree("t1")], kept: [] });
    const clone = join(root, "repos", "acme", "web");
    expect(existsSync(join(root, "tickets", "t1"))).toBe(false);
    expect(await gh.sh(["worktree", "list", "--porcelain"], clone)).not.toContain("t1");
    expect(await gh.sh(["branch", "--list", "ticket/t1"], clone)).toBe("");
    expect(ws.ticketIds()).toEqual([]);

    // A reopened ticket gets a new worktree.
    expect((await prepare("t1")).failed).toEqual([]);
    expect(readme("t1")).toBe("v1");
  });

  it("keeps a worktree with changes, and a branch with commits git doesn't call merged", async () => {
    await gh.push("acme/api", { "README.md": "api" });
    await prepare("t1", [WEB, { alias: "api", repo: "acme/api" }]);
    writeFileSync(join(worktree("t1"), "untracked.txt"), "wip");
    const api = worktree("t1", "api");
    writeFileSync(join(api, "fix.txt"), "fixed");
    await gh.sh(["add", "fix.txt"], api);
    await gh.sh(["commit", "--quiet", "-m", "squash-merged fix"], api);

    const result = await workspaces().cleanup("t1");
    expect(result.removed).toEqual([api]);
    expect(result.kept).toEqual([
      {
        path: worktree("t1"),
        reason: expect.stringMatching(/^git worktree remove exited with 128: .*untracked/),
      },
    ]);
    expect(readFileSync(join(worktree("t1"), "untracked.txt"), "utf8")).toBe("wip");
    expect(
      await gh.sh(["branch", "--list", "ticket/t1"], join(root, "repos", "acme", "api")),
    ).toContain("ticket/t1");

    // Reopened, the ticket finds its commit again.
    await prepare("t1", [WEB, { alias: "api", repo: "acme/api" }]);
    expect(readFileSync(join(api, "fix.txt"), "utf8")).toBe("fixed");
  });

  it("leaves everything in the folder that isn't a worktree of a clone it made", async () => {
    await prepare("t1");
    const dir = join(root, "tickets", "t1");
    writeFileSync(join(dir, "notes.md"), "notes");
    mkdirSync(join(dir, "plain"));
    mkdirSync(join(dir, "garbled"));
    writeFileSync(join(dir, "garbled", ".git"), "not a gitdir line");
    symlinkSync(worktree("t1"), join(dir, "link"));
    // The agent's own clone, and worktrees of repos the Watcher didn't clone.
    await gh.sh(
      ["clone", "--quiet", `file://${join(base, "github", "acme", "web.git")}`, join(dir, "own")],
      base,
    );
    await gh.sh(["worktree", "add", "--quiet", join(dir, "elsewhere")], join(dir, "own"));
    await gh.sh(
      [
        "clone",
        "--quiet",
        `file://${join(base, "github", "acme", "web.git")}`,
        join(root, "sibling"),
      ],
      base,
    );
    await gh.sh(["worktree", "add", "--quiet", join(dir, "sibling")], join(root, "sibling"));

    const result = await workspaces().cleanup("t1");
    expect(result.removed).toEqual([worktree("t1")]);
    expect(result.kept.map((k) => k.path.slice(dir.length + 1)).sort()).toEqual([
      "elsewhere",
      "garbled",
      "link",
      "notes.md",
      "own",
      "plain",
      "sibling",
    ]);
    expect(new Set(result.kept.map((k) => k.reason))).toEqual(
      new Set(["not a worktree of a repo the Watcher cloned"]),
    );
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("notes");
  });

  it("lists only ticket folders, and cleans nothing for an unknown or unsafe id", async () => {
    const ws = workspaces();
    expect(ws.ticketIds()).toEqual([]);
    await prepare("t1");
    writeFileSync(join(root, "tickets", "stray.txt"), "");
    mkdirSync(join(root, "tickets", ".hidden"));
    expect(ws.ticketIds()).toEqual(["t1"]);
    expect(await ws.cleanup("t9")).toEqual({ removed: [], kept: [] });
    expect(await ws.cleanup("../tickets")).toEqual({ removed: [], kept: [] });
    expect(existsSync(worktree("t1"))).toBe(true);
  });
});
