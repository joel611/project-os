import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type Git, prepareWorkspace, type RepoSource } from "./workspace.ts";

const TOKEN = "gho_person_token_123";
const basic = (token: string) => btoa(`x-access-token:${token}`);

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "workspace-test-"));
  root = join(base, "workspaces");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

type Call = { args: readonly string[]; cwd: string; env: Record<string, string | undefined> };

/**
 * A git that "clones" by writing a README into the target folder. `public` repos clone without
 * auth; any other repo clones only with the person's token in the extraheader.
 */
const fakeGit = (options: { public?: string[]; stderr?: string } = {}) => {
  const calls: Call[] = [];
  const git: Git = async (args, { cwd, env }) => {
    calls.push({ args, cwd, env });
    const url = args.at(-2)!;
    const target = args.at(-1)!;
    const repo = /^https:\/\/github\.com\/(.+)\.git$/.exec(url)?.[1] ?? "";
    const header = Object.entries(env).find(
      ([k, v]) => k.startsWith("GIT_CONFIG_VALUE_") && v?.includes(basic(TOKEN)),
    );
    // A clone cut short leaves a folder behind.
    mkdirSync(target, { recursive: true });
    if (!options.public?.includes(repo) && !header) {
      return {
        code: 128,
        stderr: options.stderr ?? "fatal: could not read Username: terminal prompts disabled\n",
      };
    }
    writeFileSync(join(target, "README.md"), repo);
    return { code: 0, stderr: "" };
  };
  return { git, calls };
};

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

const prepare = (
  git: Git,
  repos: RepoSource[],
  githubToken = tokens(async () => TOKEN).githubToken,
  ticketId = "t1",
  env: Record<string, string | undefined> = { PATH: "/bin" },
) => prepareWorkspace({ root, git, env }, { ticketId, repos, githubToken });

describe("prepareWorkspace", () => {
  it("clones the project's only repo into <root>/<ticket>/<alias> and starts there", async () => {
    const { git, calls } = fakeGit({ public: ["acme/web"] });
    const ws = await prepare(git, [{ alias: "web", repo: "acme/web" }]);
    const path = join(root, "t1", "web");
    expect(ws).toEqual({
      cwd: path,
      checkouts: [{ alias: "web", repo: "acme/web", path }],
      failed: [],
    });
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("acme/web");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["clone", "--quiet", "--"]);
    expect(calls[0]!.args).toContain("https://github.com/acme/web.git");
    // Only the checkout is left in the ticket's folder.
    expect(readdirSync(join(root, "t1"))).toEqual(["web"]);
  });

  it("starts in the ticket's folder with several repos, and an empty one with none", async () => {
    const { git } = fakeGit({ public: ["acme/web", "acme/api"] });
    const two = await prepare(git, [
      { alias: "web", repo: "acme/web" },
      { alias: "api", repo: "acme/api" },
    ]);
    expect(two.cwd).toBe(join(root, "t1"));
    expect(two.checkouts.map((c) => c.alias)).toEqual(["web", "api"]);

    const none = await prepare(git, [], undefined, "t2");
    expect(none).toEqual({ cwd: join(root, "t2"), checkouts: [], failed: [] });
    expect(readdirSync(join(root, "t2"))).toEqual([]);
  });

  it("reuses a checkout as it is, so a reopened ticket keeps its uncommitted work", async () => {
    const { git, calls } = fakeGit({ public: ["acme/web"] });
    await prepare(git, [{ alias: "web", repo: "acme/web" }]);
    const notes = join(root, "t1", "web", "notes.txt");
    writeFileSync(notes, "half done");

    const again = await prepare(git, [{ alias: "web", repo: "acme/web" }]);
    expect(calls).toHaveLength(1);
    expect(again.cwd).toBe(join(root, "t1", "web"));
    expect(readFileSync(notes, "utf8")).toBe("half done");
  });

  it("never takes a clone cut short for a checkout, and replaces one a crash left", async () => {
    const { git } = fakeGit();
    const failing = await prepare(git, [{ alias: "web", repo: "acme/web" }], async () => {
      throw new Error("NotConnected");
    });
    expect(failing.cwd).toBe(join(root, "t1"));
    expect(readdirSync(join(root, "t1"))).toEqual([]);

    // A Watcher that died mid-clone left a partial folder behind.
    mkdirSync(join(root, "t1", ".web.partial", "junk"), { recursive: true });
    const { git: works } = fakeGit({ public: ["acme/web"] });
    const ws = await prepare(works, [{ alias: "web", repo: "acme/web" }]);
    expect(ws.failed).toEqual([]);
    expect(readdirSync(join(root, "t1"))).toEqual(["web"]);
    expect(readdirSync(join(root, "t1", "web"))).toEqual(["README.md"]);
  });

  it("asks for the person's token only when the anonymous clone fails, and at most once", async () => {
    const { git, calls } = fakeGit({ public: ["acme/web"] });
    const t = tokens(async () => TOKEN);
    const ws = await prepare(
      git,
      [
        { alias: "web", repo: "acme/web" },
        { alias: "api", repo: "acme/api" },
        { alias: "ops", repo: "acme/ops" },
      ],
      t.githubToken,
    );
    expect(ws.failed).toEqual([]);
    expect(t.asked()).toBe(1);
    // web: anonymous. api and ops: anonymous, then with the token.
    expect(calls.map((c) => c.args.at(-2))).toEqual([
      "https://github.com/acme/web.git",
      "https://github.com/acme/api.git",
      "https://github.com/acme/api.git",
      "https://github.com/acme/ops.git",
      "https://github.com/acme/ops.git",
    ]);
    expect(JSON.stringify(calls[0]!.env)).not.toContain(basic(TOKEN));
    for (const call of calls) expect(call.args.join(" ")).not.toContain(TOKEN);
  });

  it("keeps the token out of the reason when the clone still fails", async () => {
    const { git } = fakeGit({ stderr: `fatal: bad header ${TOKEN} / ${basic(TOKEN)}\n` });
    // The token is valid but this git refuses every clone.
    const refusing: Git = async (args, options) => {
      const result = await git(args, { ...options, env: {} });
      return { ...result, code: 128 };
    };
    const ws = await prepare(refusing, [{ alias: "web", repo: "acme/web" }]);
    expect(ws.failed).toHaveLength(1);
    expect(ws.failed[0]!.reason).toMatch(/^git clone exited with 128: /);
    expect(ws.failed[0]!.reason).not.toContain(TOKEN);
    expect(ws.failed[0]!.reason).not.toContain(basic(TOKEN));
  });

  it("reports a repo it can't clone instead of throwing, with why", async () => {
    const { git } = fakeGit();
    const ws = await prepare(git, [{ alias: "web", repo: "acme/web" }], async () => {
      throw new Error('MCP user_token: {"_tag":"NotConnected"}');
    });
    expect(ws.checkouts).toEqual([]);
    expect(ws.failed).toEqual([
      {
        alias: "web",
        repo: "acme/web",
        reason: expect.stringMatching(/terminal prompts disabled.*no GitHub token.*NotConnected/),
      },
    ]);
  });

  it("says so when git fails without printing anything", async () => {
    const ws = await prepare(
      async () => ({ code: 137, stderr: "" }),
      [{ alias: "web", repo: "acme/web" }],
    );
    expect(ws.failed[0]!.reason).toBe("git clone exited with 137: no output");
  });

  it.each(["../evil", "a/b", ".", "..", "", "-rf", "t1\n"])(
    "refuses ticket id %j, which would leave the workspaces folder",
    async (ticketId) => {
      const { git, calls } = fakeGit({ public: ["acme/web"] });
      await expect(
        prepare(git, [{ alias: "web", repo: "acme/web" }], undefined, ticketId),
      ).rejects.toThrow(/unsafe ticket id/);
      expect(calls).toEqual([]);
      expect(existsSync(root)).toBe(false);
    },
  );

  it("skips aliases and repos that would escape the ticket's folder or reach git as options", async () => {
    const { git, calls } = fakeGit({ public: ["acme/web"] });
    const ws = await prepare(git, [
      { alias: "../web", repo: "acme/web" },
      { alias: "-c", repo: "acme/web" },
      { alias: ".git", repo: "acme/web" },
      { alias: "site", repo: "--upload-pack=touch /tmp/x" },
      { alias: "lab", repo: "gitlab.com/acme/web" },
      { alias: "web", repo: "https://github.com/Acme/Web" },
    ]);
    expect(ws.failed.map((f) => f.alias)).toEqual(["../web", "-c", ".git", "site", "lab"]);
    expect(ws.checkouts).toEqual([
      { alias: "web", repo: "acme/web", path: join(root, "t1", "web") },
    ]);
    expect(calls.map((c) => c.args.at(-2))).toEqual(["https://github.com/acme/web.git"]);
    expect(readdirSync(base)).toEqual(["workspaces"]);
  });

  it("runs git without this computer's credentials, config, or prompts", async () => {
    const { git, calls } = fakeGit();
    await prepare(git, [{ alias: "web", repo: "acme/web" }], undefined, "t1", {
      PATH: "/bin",
      HOME: "/home/owner",
      GIT_ASKPASS: "/usr/bin/owner-askpass",
      SSH_ASKPASS: "/usr/bin/owner-askpass",
      GIT_CONFIG_PARAMETERS: "'url.git@github.com:.insteadOf'='https://github.com/'",
      HTTPS_PROXY: "http://proxy:3128",
    });
    for (const { env } of calls) {
      expect(env).toMatchObject({
        PATH: "/bin",
        HTTPS_PROXY: "http://proxy:3128",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
      });
      expect(env.HOME).not.toBe("/home/owner");
      expect(env).not.toHaveProperty("GIT_ASKPASS");
      expect(env).not.toHaveProperty("SSH_ASKPASS");
      expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
    }
  });

  it("gives real git no credential helper and only the person's header", async () => {
    // Real git reads back the config it would clone with: none of this computer's settings.
    const seen: string[] = [];
    const git: Git = async (args, { cwd, env }) => {
      const proc = Bun.spawn(["git", "config", "--list", "--show-scope"], {
        cwd,
        env: env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      seen.push(await new Response(proc.stdout).text());
      await proc.exited;
      return { code: 128, stderr: "fatal: refused" };
    };
    await prepare(git, [{ alias: "web", repo: "acme/web" }], undefined, "t1", process.env);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.trim().split("\n")).toEqual(["command\tcredential.helper="]);
    expect(seen[1]!.trim().split("\n")).toEqual([
      "command\tcredential.helper=",
      `command\thttp.https://github.com/.extraheader=AUTHORIZATION: basic ${basic(TOKEN)}`,
    ]);
  });
});
