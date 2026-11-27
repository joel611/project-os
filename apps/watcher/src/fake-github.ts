import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Git, type GitResult, gitRunner } from "./git.ts";

const GITHUB_URL = /^https:\/\/github\.com\/(.+)\.git$/;
const HEADER = "AUTHORIZATION: basic ";

/**
 * Test stand-in for GitHub, behind real git. A command that names
 * `https://github.com/<repo>.git` reaches a bare repo under `dir` over the file protocol, which
 * only this seam allows. A private repo answers "not found" unless the command carries a token
 * of one of its readers. A stalled repo takes the connection and never answers, and git gives up
 * on it after `stallTimeoutMs`. Every other git command runs as it is. Production never uses this.
 */
export const fakeGithub = (dir: string, options: { readonly stallTimeoutMs?: number } = {}) => {
  const runner = gitRunner({ timeoutMs: 60_000 });
  const stalledRunner = gitRunner({ timeoutMs: options.stallTimeoutMs ?? 1_000 });
  const readers = new Map<string, ReadonlySet<string>>();
  const stalled = new Set<string>();
  const calls: Array<{ args: readonly string[]; env: Record<string, string | undefined> }> = [];
  const bare = (repo: string) => join(dir, `${repo}.git`);
  const plain = {
    PATH: process.env.PATH,
    HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.com",
  };
  /** Runs git as a person at a terminal would, outside the Watcher. Throws when it fails. */
  const sh = async (args: readonly string[], cwd: string) => {
    const result = await runner.run(args, { cwd, env: plain });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  let server: { readonly port: number; readonly stop: (force: boolean) => void } | undefined;

  const git: Git = async (args, { cwd, env }) => {
    calls.push({ args, env });
    const at = args.findIndex((arg) => GITHUB_URL.test(arg));
    if (at === -1) return runner.run(args, { cwd, env });
    const repo = GITHUB_URL.exec(args[at]!)![1]!;
    const notFound: GitResult = {
      code: 128,
      stdout: "",
      stderr: `remote: Repository not found.\nfatal: repository '${args[at]}/' not found\n`,
    };
    if (stalled.has(repo)) {
      const listening = (server ??= Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data: () => {} },
      }));
      const url = `https://127.0.0.1:${listening.port}/${repo}.git`;
      return stalledRunner.run(
        args.map((arg, i) => (i === at ? url : arg)),
        { cwd, env },
      );
    }
    const allowed = readers.get(repo);
    const header = Object.values(env).find((value) => value?.startsWith(HEADER));
    const token = header && atob(header.slice(HEADER.length)).split(":")[1];
    if (!existsSync(bare(repo)) || (allowed && !allowed.has(token ?? ""))) return notFound;
    return runner.run(
      args.map((arg, i) => (i === at ? `file://${bare(repo)}` : arg)),
      { cwd, env: { ...env, GIT_ALLOW_PROTOCOL: "file" } },
    );
  };

  return {
    git,
    calls,
    sh,
    /** Commits `files` to `repo`'s default branch `main`, creating the repo on first use. */
    push: async (repo: string, files: Record<string, string>, message = "update") => {
      if (!existsSync(bare(repo))) {
        mkdirSync(dirname(bare(repo)), { recursive: true });
        await sh(["init", "--quiet", "--bare", "--initial-branch=main", bare(repo)], dir);
      }
      const work = mkdtempSync(join(dir, "push-"));
      try {
        await sh(["clone", "--quiet", bare(repo), work], dir);
        for (const [path, contents] of Object.entries(files)) {
          mkdirSync(dirname(join(work, path)), { recursive: true });
          writeFileSync(join(work, path), contents);
        }
        await sh(["add", "--all"], work);
        await sh(["commit", "--quiet", "--allow-empty", "-m", message], work);
        await sh(["push", "--quiet", "origin", "HEAD:main"], work);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    /** Makes `repo` private: only these tokens can read it. */
    restrict: (repo: string, tokens: readonly string[]) => void readers.set(repo, new Set(tokens)),
    /** Makes `repo` take connections and never answer. */
    stall: (repo: string) => void stalled.add(repo),
    stop: () => server?.stop(true),
  };
};
