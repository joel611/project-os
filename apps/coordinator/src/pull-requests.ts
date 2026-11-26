import {
  ChannelGateway,
  IdGenerator,
  TicketRepository,
  UserConnections,
  requesterOf,
} from "@project-os/core";
import { pullRequestSettled, ticketPullRequests } from "@project-os/contracts";
import { Effect } from "effect";

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
        const { links, merged } = ticketPullRequests(events);
        const pending = links.filter((url) => !merged.has(url));
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
              payload: pullRequestSettled(url),
              createdAt: new Date().toISOString(),
            });
          }).pipe(Effect.ignoreCause);
        }
      }).pipe(Effect.ignoreCause);
    }
  });
