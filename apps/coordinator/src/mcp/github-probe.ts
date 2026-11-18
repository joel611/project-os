import { appendEvent, listProjectSources, TicketRepository } from "@project-os/core";
import { Effect } from "effect";

export const GITHUB_API = "https://api.github.com";

interface CallResult {
  /** HTTP status; 0 when the request never got an answer. */
  readonly status: number;
  readonly requestId: string | null;
  readonly scopes: string | null;
  readonly json: unknown;
  readonly error?: string;
}

const call = async (api: string, token: string, path: string): Promise<CallResult> => {
  try {
    const res = await fetch(`${api}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "coordinator",
      },
      signal: AbortSignal.timeout(5_000),
    });
    return {
      status: res.status,
      requestId: res.headers.get("x-github-request-id"),
      scopes: res.headers.get("x-oauth-scopes"),
      json: res.ok ? await res.json().catch(() => undefined) : undefined,
    };
  } catch (e) {
    return {
      status: 0,
      requestId: null,
      scopes: null,
      json: undefined,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export interface GithubProbe {
  readonly login: string | null;
  readonly scopes: string | null;
  readonly user: { readonly status: number; readonly requestId: string | null };
  readonly installations: {
    readonly status: number;
    readonly requestId: string | null;
    readonly accounts: ReadonlyArray<{ readonly account: string; readonly selection: string }>;
  };
  readonly repos: ReadonlyArray<{
    readonly repo: string;
    readonly status: number;
    readonly requestId: string | null;
  }>;
}

/**
 * What `token` can reach on GitHub: who it is, which app installations it sees, and whether each
 * repo is visible. GitHub answers 404 for a repo the token cannot see, so these three together
 * tell a missing installation from a wrong account. Never throws; the token is not in the result.
 */
export const probeGithub = async (
  api: string,
  token: string,
  repos: ReadonlyArray<string>,
): Promise<GithubProbe> => {
  const [user, installations, ...checked] = await Promise.all([
    call(api, token, "/user"),
    call(api, token, "/user/installations"),
    ...repos.map((repo) => call(api, token, `/repos/${repo}`)),
  ]);
  const login = record(user.json).login;
  const list = record(installations.json).installations;
  return {
    login: typeof login === "string" ? login : null,
    scopes: user.scopes,
    user: { status: user.status, requestId: user.requestId },
    installations: {
      status: installations.status,
      requestId: installations.requestId,
      accounts: Array.isArray(list)
        ? list.map((i) => ({
            account: String(record(record(i).account).login ?? "?"),
            selection: String(record(i).repository_selection ?? "?"),
          }))
        : [],
    },
    repos: repos.map((repo, i) => ({
      repo,
      status: checked[i]!.status,
      requestId: checked[i]!.requestId,
    })),
  };
};

export const describeProbe = (probe: GithubProbe): string => {
  const who = probe.login ? `as ${probe.login}` : `(GET /user answered ${probe.user.status})`;
  const repos = probe.repos.map((r) => `${r.repo} ${r.status}`).join(", ") || "no repo sources";
  const apps =
    probe.installations.accounts.map((a) => `${a.account} (${a.selection})`).join(", ") ||
    `none (GET /user/installations answered ${probe.installations.status})`;
  return `GitHub access check ${who}: ${repos}. App installations: ${apps}.`;
};

/**
 * Leaves a `system` event on the ticket saying what its requester's GitHub token can reach, so a
 * Worker's "404" can be diagnosed later. Failures here never reach the Worker.
 */
export const traceGithubAccess = (ticketId: string, token: string, api: string) =>
  Effect.gen(function* () {
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    const sources = yield* listProjectSources({ projectId: ticket.projectId });
    const repos = sources.filter((s) => s.type === "github_repo").map((s) => s.externalId);
    const probe = yield* Effect.promise(() => probeGithub(api, token, repos));
    yield* appendEvent({
      ticketId,
      type: "system",
      actor: "coordinator",
      body: describeProbe(probe),
      payload: { kind: "github_probe", ...probe },
    });
  }).pipe(Effect.ignore);
