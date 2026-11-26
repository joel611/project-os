import { describe, expect, it } from "vite-plus/test";
import { pullRequestLinks, pullRequestSettled, ticketPullRequests } from "./pull-requests.ts";

const PR = "https://github.com/acme/web/pull/42";
const result = (body: string) => ({ type: "result", actor: "worker", body, payload: null });
const settled = (payload: unknown, actor = "coordinator") => ({
  type: "system",
  actor,
  body: "PR merged",
  payload,
});

describe("pullRequestLinks", () => {
  it("only accepts canonical GitHub PR links and deduplicates URL fragments", () => {
    expect(
      pullRequestLinks(
        `${PR} ${PR}#issuecomment-1 ${PR}?x=1 ${PR}/files https://github.com.evil/acme/web/pull/1 https://evil.test/acme/web/pull/1`,
      ),
    ).toEqual([PR]);
  });
});

describe("ticketPullRequests", () => {
  it("lists the PRs in the Worker's results and the ones recorded as merged", () => {
    const second = "https://github.com/acme/api/pull/7";
    const prs = ticketPullRequests([
      { type: "comment", actor: "worker", body: "see https://github.com/acme/web/pull/1" },
      { type: "result", actor: "coordinator", body: "https://github.com/acme/web/pull/2" },
      result(`Done: ${PR}`),
      result(`Also ${second}/files`),
      settled(pullRequestSettled(PR)),
    ]);
    expect(prs.links).toEqual([PR, second]);
    expect([...prs.merged]).toEqual([PR]);
  });

  it("counts only the Coordinator's merged receipts", () => {
    const prs = ticketPullRequests([
      result(PR),
      settled({ kind: "pull_request_settled", url: PR, merged: false }),
      settled(pullRequestSettled(PR), "worker"),
      settled({ kind: "pull_request_settled", merged: true }),
      settled({ kind: "other", url: PR, merged: true }),
    ]);
    expect(prs.merged.size).toBe(0);
  });
});
