import {
  ChannelGateway,
  IdGenerator,
  TicketRepository,
  UserConnections,
  requesterOf,
} from "@project-os/core";
import { Effect } from "effect";

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

const SETTLED = "pull_request_settled";

/**
 * Poll completed workers' results using the latest human requester's GitHub access.
 * History is the durable watch list and receipt: restarts need no in-memory registration.
 * Sending precedes the receipt so a failed send retries. A crash between them can duplicate
 * a notice (at-least-once delivery), as with other channel notifications.
 */
export const checkPullRequests = (options: { readonly fetch: typeof fetch }) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const gateway = yield* ChannelGateway;
    const connections = yield* UserConnections;
    const ids = yield* IdGenerator;
    const completed = yield* tickets.listByStatus(["completed"]);
    for (const ticket of completed) {
      yield* Effect.gen(function* () {
        const thread = yield* tickets.findThread(ticket.id);
        if (!thread) return;
        const events = yield* tickets.listEvents(ticket.id);
        const links = pullRequestLinks(
          events
            .filter((event) => event.type === "result" && event.actor === "worker")
            .map((event) => event.body)
            .join("\n"),
        );
        const settled = new Set(
          events.flatMap((event) => {
            const payload = event.payload as { kind?: string; url?: string } | null;
            return event.actor === "coordinator" && payload?.kind === SETTLED && payload.url
              ? [payload.url]
              : [];
          }),
        );
        const pending = links.filter((url) => !settled.has(url));
        if (!pending.length) return;
        const person = requesterOf(events);
        if (!person) return;
        // No bot credentials and no /connect nag on an already completed ticket.
        const token = yield* connections.accessToken(person, "github");
        for (const url of pending) {
          yield* Effect.gen(function* () {
            const [, owner, repo, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)!;
            const response = yield* Effect.tryPromise(() =>
              options.fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
                headers: {
                  authorization: `Bearer ${token.accessToken}`,
                  accept: "application/vnd.github+json",
                  "user-agent": "project-os",
                },
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
              }),
            );
            // Access errors, rate limits and transient errors retry on a later tick.
            if (!response.ok) return;
            const pr = yield* Effect.tryPromise(
              () => response.json() as Promise<{ merged?: boolean }>,
            );
            if (pr.merged !== true) return;
            const body = `PR merged: ${url}`;
            yield* gateway.send({
              channelType: thread.channelType,
              channelId: thread.channelId,
              threadId: thread.threadId,
              content: body,
            });
            yield* tickets.appendEvent({
              id: yield* ids.next,
              ticketId: ticket.id,
              type: "system",
              actor: "coordinator",
              actorId: null,
              body,
              payload: { kind: SETTLED, url, merged: true },
              createdAt: new Date().toISOString(),
            });
          }).pipe(Effect.ignoreCause);
        }
      }).pipe(Effect.ignoreCause);
    }
  });
