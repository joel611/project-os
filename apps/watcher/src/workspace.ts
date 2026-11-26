import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeGithubRepo } from "@project-os/contracts";
import { errorMessage } from "./logger.ts";

/** A GitHub repo the ticket's project links, under the alias people gave it. */
export interface RepoSource {
  readonly alias: string;
  /** `owner/name`. */
  readonly repo: string;
}

export interface Checkout extends RepoSource {
  readonly path: string;
}

export interface FailedRepo extends RepoSource {
  readonly reason: string;
}

/** A ticket's folder, with the project's repos checked out in it. */
export interface Workspace {
  /** Where the session starts: the only repo's checkout, else the ticket's folder. */
  readonly cwd: string;
  readonly checkouts: readonly Checkout[];
  readonly failed: readonly FailedRepo[];
}

/** Runs `git` with `args`; resolves with its exit code and what it wrote to stderr. */
export type Git = (
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) => Promise<{ readonly code: number; readonly stderr: string }>;

export interface WorkspaceIo {
  /** `<configDir>/workspaces`: one folder per ticket. */
  readonly root: string;
  readonly git: Git;
  /** The environment git starts from. Its `GIT_*` settings are dropped. */
  readonly env: Record<string, string | undefined>;
}

/** Ticket ids become a folder name, so they must be one plain path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The Coordinator's alias rule: lowercase letters and digits joined by `-` or `_`. */
const SAFE_ALIAS = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Git with none of this computer's own credentials or settings: a shared worker serves other
 * people, so their repos must never be read with the owner's login. No system or global config
 * (credential helpers, `url.*.insteadOf`, extra headers), no `~/.netrc`, no prompts. `token`, when
 * given, goes in as an `extraheader` through the environment, so it never reaches argv or
 * `.git/config`.
 */
const isolatedEnv = (io: WorkspaceIo, token?: string): Record<string, string | undefined> => {
  const config: Array<[string, string]> = [["credential.helper", ""]];
  if (token) {
    const basic = btoa(`x-access-token:${token}`);
    config.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
  }
  return {
    ...Object.fromEntries(
      Object.entries(io.env).filter(([name]) => !name.startsWith("GIT_") && name !== "SSH_ASKPASS"),
    ),
    HOME: io.root,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
};

/** The last line git printed, without `secrets`, short enough for a prompt. */
const gitReason = (code: number, stderr: string, secrets: readonly string[]): string => {
  let line = stderr.trim().split("\n").at(-1)?.trim() || "no output";
  for (const secret of secrets) line = line.replaceAll(secret, "***");
  return `git clone exited with ${code}: ${line.slice(0, 200)}`;
};

/**
 * Clones `repo` to `path`. Anonymous first, so a public repo never asks the person to connect
 * GitHub; with their token only when that fails. The clone goes to a sibling folder and is
 * renamed into place, so a clone cut short is never mistaken for a checkout.
 */
const cloneRepo = async (
  io: WorkspaceIo,
  dir: string,
  { alias, repo }: RepoSource,
  githubToken: () => Promise<string>,
): Promise<string | undefined> => {
  const path = join(dir, alias);
  const partial = join(dir, `.${alias}.partial`);
  const clone = async (token?: string) => {
    rmSync(partial, { recursive: true, force: true });
    const url = `https://github.com/${repo}.git`;
    const result = await io.git(["clone", "--quiet", "--", url, partial], {
      cwd: dir,
      env: isolatedEnv(io, token),
    });
    if (result.code === 0) renameSync(partial, path);
    else rmSync(partial, { recursive: true, force: true });
    return result;
  };
  const anonymous = await clone();
  if (anonymous.code === 0) return undefined;
  let token: string;
  try {
    token = await githubToken();
  } catch (e) {
    const why = errorMessage(e).slice(0, 200);
    return `${gitReason(anonymous.code, anonymous.stderr, [])}; no GitHub token for the person behind this ticket (${why})`;
  }
  const authed = await clone(token);
  return authed.code === 0
    ? undefined
    : gitReason(authed.code, authed.stderr, [token, btoa(`x-access-token:${token}`)]);
};

/**
 * The ticket's folder `<root>/<ticketId>`, with each repo checked out at `<alias>/`. A checkout
 * that is already there is kept as it is (a reopened ticket keeps its work), and nothing here
 * ever deletes one. A repo that can't be cloned is reported in `failed`, not thrown, so the
 * session still starts. `githubToken` is asked at most once.
 */
export const prepareWorkspace = async (
  io: WorkspaceIo,
  input: {
    readonly ticketId: string;
    readonly repos: readonly RepoSource[];
    readonly githubToken: () => Promise<string>;
  },
): Promise<Workspace> => {
  if (!SAFE_SEGMENT.test(input.ticketId)) {
    throw new Error(`refusing a workspace for unsafe ticket id ${JSON.stringify(input.ticketId)}`);
  }
  const ticketDir = join(io.root, input.ticketId);
  mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
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
      : await cloneRepo(io, ticketDir, { alias: source.alias, repo }, githubToken);
    if (reason === undefined) checkouts.push({ alias: source.alias, repo, path });
    else failed.push({ alias: source.alias, repo, reason });
  }
  const only = input.repos.length === 1 ? checkouts[0] : undefined;
  return { cwd: only?.path ?? ticketDir, checkouts, failed };
};
