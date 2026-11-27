/** The `kind` of the system event the Coordinator appends once a Worker's PR is merged. */
export const PULL_REQUEST_SETTLED = "pull_request_settled";

/** That event's payload. */
export const pullRequestSettled = (url: string) =>
  ({ kind: PULL_REQUEST_SETTLED, url, merged: true }) as const;

/** Only public GitHub PR URLs, never arbitrary worker-supplied hosts or API paths. */
export const pullRequestLinks = (text: string): string[] => [
  ...new Set(
    Array.from(
      text.matchAll(
        /https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\/pull\/([1-9]\d*)(?=$|[^\w])/g,
      ),
      (match) => `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    ),
  ),
];

/**
 * The PRs a ticket's Worker reported in its `result` events, and the ones the Coordinator has
 * recorded as merged. Links in comments or other events don't count.
 */
export const ticketPullRequests = (
  events: ReadonlyArray<{
    readonly type: string;
    readonly actor: string;
    readonly body: string;
    readonly payload?: unknown;
  }>,
): { readonly links: readonly string[]; readonly merged: ReadonlySet<string> } => ({
  links: pullRequestLinks(
    events
      .filter((event) => event.type === "result" && event.actor === "worker")
      .map((event) => event.body)
      .join("\n"),
  ),
  merged: new Set(
    events.flatMap((event) => {
      const payload = event.payload as { kind?: unknown; url?: unknown; merged?: unknown } | null;
      return event.actor === "coordinator" &&
        payload?.kind === PULL_REQUEST_SETTLED &&
        payload.merged === true &&
        typeof payload.url === "string"
        ? [payload.url]
        : [];
    }),
  ),
});
