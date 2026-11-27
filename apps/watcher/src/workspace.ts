import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { normalizeGithubRepo } from "@project-os/contracts";
import type { Git, GitResult } from "./git.ts";
import { errorMessage } from "./logger.ts";

/** A GitHub repo the ticket's project links, under the alias people gave it. */
export interface RepoSource {
  readonly alias: string;
  /** `owner/name`. */
  readonly repo: string;
}

export interface Checkout extends RepoSource {
  readonly path: string;
  /** The ticket's branch the worktree was made on. */
  readonly branch: string;
}

export interface FailedRepo extends RepoSource {
  readonly reason: string;
}

/** A ticket's folder, with a worktree of each of the project's repos in it. */
export interface Workspace {
  /** Where the session starts: the only repo's worktree, else the ticket's folder. */
  readonly cwd: string;
  readonly checkouts: readonly Checkout[];
  readonly failed: readonly FailedRepo[];
}

/** What cleaning up a ticket's folder did. */
export interface Cleanup {
  readonly removed: readonly string[];
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export interface WorkspacesIo {
  /** `<configDir>/workspaces`. */
  readonly root: string;
  readonly git: Git;
  /** The environment git starts from. Its `GIT_*` settings are dropped. */
  readonly env: Record<string, string | undefined>;
}

export interface Workspaces {
  /**
   * The ticket's folder `tickets/<ticketId>`, with a worktree of each repo at `<alias>/` on the
   * branch `ticket/<ticketId>`. A worktree that is already there is kept as it is. A repo that
   * can't be checked out is reported in `failed`, not thrown, so the session still starts.
   * `githubToken` is asked at most once.
   */
  readonly prepare: (input: {
    readonly ticketId: string;
    readonly repos: readonly RepoSource[];
    readonly githubToken: () => Promise<string>;
  }) => Promise<Workspace>;
  /** The tickets that have a folder. */
  readonly ticketIds: () => string[];
  /**
   * Removes the ticket's worktrees that hold no changes, the ticket's branch where git calls it
   * merged, and the ticket's folder once it is empty. Anything else stays, listed in `kept`.
   */
  readonly cleanup: (ticketId: string) => Promise<Cleanup>;
}

/** Ticket ids become a folder and branch name, so they must be one plain path segment. */
export const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The Coordinator's alias rule: lowercase letters and digits joined by `-` or `_`. */
const SAFE_ALIAS = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const ticketBranch = (ticketId: string) => `ticket/${ticketId}`;

const basic = (token: string) => btoa(`x-access-token:${token}`);

/**
 * Git with none of this computer's own credentials or settings: a shared worker serves other
 * people, so their repos must never be read with the owner's login. No system or global config,
 * no `~/.netrc`, no prompts, https only. Base clones are shared by tickets, and agents can write
 * their `.git/config` and hooks, so the settings below are forced at command scope, which beats
 * the repo's own: no hooks, no fsmonitor, no credential helper or askpass, TLS verified. For
 * `network`, the same for that exact URL (the most specific match): no proxy but the
 * environment's, no pinned DNS, and only `token` as its auth header. The token goes in through
 * the environment, never argv or `.git/config`.
 */
const gitEnv = (
  env: Record<string, string | undefined>,
  network?: { readonly url: string; readonly token?: string },
): Record<string, string | undefined> => {
  const config: Array<[string, string]> = [
    ["credential.helper", ""],
    ["core.askPass", ""],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.alternateRefsCommand", "true"],
    ["http.sslVerify", "true"],
  ];
  if (network) {
    const { url, token } = network;
    const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? "";
    config.push(
      [`http.${url}.sslVerify`, "true"],
      [`http.${url}.followRedirects`, "initial"],
      [`http.${url}.proxy`, proxy],
      [`remote.${url}.proxy`, proxy],
      [`http.${url}.curloptResolve`, ""],
      [`http.${url}.extraHeader`, ""],
    );
    if (token) config.push([`http.${url}.extraHeader`, `AUTHORIZATION: basic ${basic(token)}`]);
  }
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !name.startsWith("GIT_") && name !== "SSH_ASKPASS"),
    ),
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
};

const ok = (result: GitResult) => result.code === 0 && result.timedOutMs === undefined;

/** Why `git <command>` failed, without `secrets`, short enough for a prompt. */
const failure = (command: string, result: GitResult, secrets: readonly string[] = []): string => {
  if (result.timedOutMs !== undefined) {
    return `git ${command} timed out after ${Math.round(result.timedOutMs / 1000)}s`;
  }
  let line = result.stderr.trim().split("\n").at(-1)?.trim() || "no output";
  for (const secret of secrets) line = line.replaceAll(secret, "***");
  return `git ${command} exited with ${result.code}: ${line.slice(0, 200)}`;
};

/**
 * Runs a networked git command anonymously first, so a public repo never asks the person to
 * connect GitHub, then with their token only when that failed. One that timed out is not tried
 * again. Resolves with why it failed, or undefined.
 */
const withAuth = async (
  command: string,
  attempt: (token?: string) => Promise<GitResult>,
  githubToken: () => Promise<string>,
): Promise<string | undefined> => {
  const anonymous = await attempt();
  if (ok(anonymous)) return undefined;
  if (anonymous.timedOutMs !== undefined) return failure(command, anonymous);
  let token: string;
  try {
    token = await githubToken();
  } catch (e) {
    const why = errorMessage(e).slice(0, 200);
    return `${failure(command, anonymous)}; no GitHub token for the person behind this ticket (${why})`;
  }
  const authed = await attempt(token);
  return ok(authed) ? undefined : failure(command, authed, [token, basic(token)]);
};

export const createWorkspaces = (io: WorkspacesIo): Workspaces => {
  const reposRoot = join(io.root, "repos");
  const ticketsRoot = join(io.root, "tickets");
  /** One chain per base clone, so sessions and cleanup never run git in it at the same time. */
  const chains = new Map<string, Promise<unknown>>();
  const locked = <T>(repo: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(repo) ?? Promise.resolve()).then(work);
    chains.set(
      repo,
      next.catch(() => undefined),
    );
    return next;
  };
  const git = (args: string[], cwd: string, network?: { url: string; token?: string }) =>
    io.git(args, { cwd, env: gitEnv(io.env, network) });

  /** Clones `repo` to `base` through a partial folder, so a clone cut short is never used. */
  const cloneBase = (base: string, url: string, githubToken: () => Promise<string>) => {
    const partial = join(reposRoot, ".partial", relative(reposRoot, base));
    mkdirSync(dirname(partial), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
    return withAuth(
      "clone",
      async (token) => {
        rmSync(partial, { recursive: true, force: true });
        const result = await git(
          ["clone", "--quiet", "--no-checkout", "--", url, partial],
          reposRoot,
          { url, ...(token && { token }) },
        );
        if (ok(result)) renameSync(partial, base);
        else rmSync(partial, { recursive: true, force: true });
        return result;
      },
      githubToken,
    );
  };

  /**
   * Fetches the default branch and the rest into `origin/*` from `url` itself, not from what
   * the clone's config now says. This is also the check that the person behind the ticket can
   * read the repo, so a clone made with someone else's token never hands them its files.
   */
  const fetchBase = async (base: string, url: string, githubToken: () => Promise<string>) => {
    // An agent can point a URL elsewhere in the clone's config; a forced setting can't undo that.
    const redirects = await git(["config", "--get-regexp", "^(url\\.|remote\\..*://)"], base);
    if (redirects.code === 0) {
      const keys = redirects.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" ")[0]);
      return `not fetched: the shared clone's git config redirects its URL (${keys.join(", ").slice(0, 200)}); remove that from ${base}/.git/config`;
    }
    return withAuth(
      "fetch",
      (token) =>
        git(
          [
            "fetch",
            "--quiet",
            "--no-tags",
            "--prune",
            "--no-recurse-submodules",
            "--no-auto-maintenance",
            "--",
            url,
            "+refs/heads/*:refs/remotes/origin/*",
          ],
          base,
          { url, ...(token && { token }) },
        ),
      githubToken,
    );
  };

  /**
   * Adds the worktree `path` on `branch`: the branch as it is when it exists,
   * else a new one from the default branch just fetched. It is made in a partial folder and
   * moved into place, so one cut short is never used.
   */
  const addWorktree = async (base: string, path: string, branch: string) => {
    const partial = join(dirname(path), `.${basename(path)}.partial`);
    rmSync(partial, { recursive: true, force: true });
    // Forgets worktrees whose folder is gone (a crash above, or someone deleted one by hand).
    await git(["worktree", "prune"], base);
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], base);
    const add = await git(
      exists.code === 0
        ? ["worktree", "add", "--quiet", partial, branch]
        : ["worktree", "add", "--quiet", "--no-track", "-b", branch, partial, "origin/HEAD"],
      base,
    );
    if (!ok(add)) return failure("worktree add", add);
    const move = await git(["worktree", "move", partial, path], base);
    return ok(move) ? undefined : failure("worktree move", move);
  };

  /** `owner/name` of the base clone whose worktree `path` is; undefined for anything else. */
  const worktreeRepo = (path: string): string | undefined => {
    try {
      const gitFile = join(path, ".git");
      if (!lstatSync(path).isDirectory() || !lstatSync(gitFile).isFile()) return undefined;
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(gitFile, "utf8"))?.[1];
      const admin = realpathSync(resolve(path, gitdir!.trim()));
      const parts = /^([^/]+)\/([^/]+)\/\.git\/worktrees\/[^/]+$/.exec(
        relative(realpathSync(reposRoot), admin),
      );
      const repo = parts && `${parts[1]}/${parts[2]}`;
      return repo && normalizeGithubRepo(repo) === repo ? repo : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    prepare: async (input) => {
      if (!SAFE_TICKET_ID.test(input.ticketId)) {
        throw new Error(
          `refusing a workspace for unsafe ticket id ${JSON.stringify(input.ticketId)}`,
        );
      }
      const ticketDir = join(ticketsRoot, input.ticketId);
      mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
      const branch = ticketBranch(input.ticketId);
      let token: Promise<string> | undefined;
      const githubToken = () => (token ??= input.githubToken());
      const checkouts: Checkout[] = [];
      const failed: FailedRepo[] = [];
      for (const source of input.repos) {
        const repo = normalizeGithubRepo(source.repo);
        if (!SAFE_ALIAS.test(source.alias)) {
          failed.push({ ...source, reason: "the alias can't be used as a folder name" });
          continue;
        }
        if (repo === null) {
          failed.push({ ...source, reason: "not a GitHub owner/name" });
          continue;
        }
        const path = join(ticketDir, source.alias);
        const reason = existsSync(path)
          ? undefined
          : await locked(repo, async () => {
              const base = join(reposRoot, repo);
              const url = `https://github.com/${repo}.git`;
              const fetched = existsSync(base)
                ? await fetchBase(base, url, githubToken)
                : await cloneBase(base, url, githubToken);
              return fetched ?? (await addWorktree(base, path, branch));
            });
        if (reason === undefined) checkouts.push({ alias: source.alias, repo, path, branch });
        else failed.push({ alias: source.alias, repo, reason });
      }
      const only = input.repos.length === 1 ? checkouts[0] : undefined;
      return { cwd: only?.path ?? ticketDir, checkouts, failed };
    },

    ticketIds: () => {
      try {
        return readdirSync(ticketsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && SAFE_TICKET_ID.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },

    cleanup: async (ticketId) => {
      const dir = join(ticketsRoot, ticketId);
      const removed: string[] = [];
      const kept: Array<{ path: string; reason: string }> = [];
      if (!SAFE_TICKET_ID.test(ticketId) || !existsSync(dir)) return { removed, kept };
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const repo = worktreeRepo(path);
        if (repo === undefined) {
          kept.push({ path, reason: "not a worktree of a repo the Watcher cloned" });
          continue;
        }
        await locked(repo, async () => {
          const base = join(reposRoot, repo);
          // Without --force: a worktree with changed or untracked files is kept.
          const result = await git(["worktree", "remove", path], base);
          if (!ok(result)) {
            kept.push({ path, reason: failure("worktree remove", result) });
            return;
          }
          removed.push(path);
          // `-d` keeps a branch git doesn't call merged; that refusal is fine.
          await git(["branch", "-d", ticketBranch(ticketId)], base);
        });
      }
      if (readdirSync(dir).length === 0) rmdirSync(dir);
      return { removed, kept };
    },
  };
};
