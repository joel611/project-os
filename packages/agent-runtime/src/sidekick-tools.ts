import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { ConnectionProvider } from "@project-os/contracts";
import type { SidekickToken } from "@project-os/core";

/** API roots the Sidekick calls; tests point these at a fake on localhost. */
export interface SidekickEndpoints {
  readonly github: string;
  readonly drive: string;
}

export const SIDEKICK_ENDPOINTS: SidekickEndpoints = {
  github: "https://api.github.com",
  drive: "https://www.googleapis.com/drive/v3",
};

export type TokenSource = (provider: ConnectionProvider) => Promise<SidekickToken>;

export interface SidekickToolsOptions {
  readonly endpoints: SidekickEndpoints;
  /** The token source of the turn this conversation is on. Throws if no turn is running. */
  readonly tokenSource: (conversationId: string) => TokenSource;
}

/** Keeps a big listing from flooding the model's context. */
const MAX_CHARS = 8_000;

/** Read paths only: repos (status, commits, runs, releases, PRs), orgs, users and search. */
const GITHUB_PATH = /^\/(repos|orgs|users|search)\/./;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const quote = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export const SIDEKICK_INSTRUCTIONS = [
  "You are the Sidekick of a project assistant. You answer questions by calling read-only tools and reporting what they return.",
  "You can list Google Drive files (drive_list) and read GitHub through its REST API (github_get): repo status, commits, pull requests, workflow runs (pipelines) and releases.",
  "You cannot check out a repo, run tests, run scripts, or change anything. If the request needs that, say so plainly and ask the person to request it as a code task.",
  "Never print or repeat an access token. If a tool says the account is not linked, tell the person to run /connect and stop.",
  "Reply in a few short lines for chat. Quote names, dates and numbers exactly as the tool returned them.",
].join("\n");

/**
 * Pi extension: the Sidekick's tools. Every call goes out with the requester's own token, so
 * the provider's permissions apply. All of them only read.
 */
export const makeSidekickExtension = (options: SidekickToolsOptions) => {
  const call = async (
    conversationId: string,
    provider: ConnectionProvider,
    url: string,
    headers: Record<string, string>,
  ): Promise<string> => {
    const token = await options.tokenSource(conversationId)(provider);
    if (!token.ok) return `Not connected: ${token.message}`;
    const res = await fetch(url, {
      headers: { ...headers, authorization: `Bearer ${token.accessToken}` },
    });
    const body = await res.text();
    if (!res.ok) return `${provider} responded ${res.status}: ${body.slice(0, 500)}`;
    return body.length > MAX_CHARS
      ? `${body.slice(0, MAX_CHARS)}\n[truncated, ${body.length} characters in all]`
      : body;
  };

  return defineExtension({
    name: "project-os-sidekick",
    tools: [
      defineTool({
        name: "drive_list",
        description:
          "List files in the person's Google Drive, newest first. Optionally only the children of a folder, or files whose name contains some text.",
        parameters: obj({ folderId: opt(str()), nameContains: opt(str()) }),
        execute: async (args, api) => {
          const clauses = ["trashed = false"];
          if (args.folderId) clauses.push(`${quote(args.folderId)} in parents`);
          if (args.nameContains) clauses.push(`name contains ${quote(args.nameContains)}`);
          const query = new URLSearchParams({
            q: clauses.join(" and "),
            orderBy: "modifiedTime desc",
            pageSize: "50",
            fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
          });
          return text(
            await call(
              String(api.conversationId),
              "google",
              `${options.endpoints.drive}/files?${query}`,
              {},
            ),
          );
        },
      }),
      defineTool({
        name: "github_get",
        description:
          "GET a path of the GitHub REST API as the person, e.g. /repos/{owner}/{repo}, /repos/{owner}/{repo}/commits?per_page=10, /repos/{owner}/{repo}/pulls?state=open, /repos/{owner}/{repo}/actions/runs?per_page=5, /repos/{owner}/{repo}/releases. Paths must start with /repos/, /orgs/, /users/ or /search/.",
        parameters: obj({ path: str() }),
        execute: async (args, api) => {
          // Check the URL as fetch will resolve it: `%2e%2e` and `//host` must not escape the allowlist.
          const root = new URL(options.endpoints.github);
          const target = args.path.startsWith("/") ? new URL(args.path, root) : undefined;
          if (!target || target.origin !== root.origin || !GITHUB_PATH.test(target.pathname)) {
            return text(
              "Refused: only GET /repos/, /orgs/, /users/ and /search/ paths are allowed.",
            );
          }
          return text(
            await call(String(api.conversationId), "github", target.toString(), {
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            }),
          );
        },
      }),
    ],
  });
};
