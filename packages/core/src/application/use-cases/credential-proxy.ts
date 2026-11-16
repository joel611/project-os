import type { ConnectionProvider, TicketStatus } from "@project-os/contracts";
import { Data, Effect } from "effect";
import { TicketRepository } from "../ports/index.ts";
import { userTokenForTicket } from "./connections.ts";
import { guardTicketAccess, type McpCaller } from "./personal-workers.ts";

/** The proxy can't tell which ticket a call is for: none open for this worker, or several. */
export class EgressTicketUnknown extends Data.TaggedError("EgressTicketUnknown")<{
  readonly workerId: string;
  readonly message: string;
}> {}

/** Statuses in which a worker is still working its ticket. */
const WORKING: ReadonlyArray<TicketStatus> = ["assigned", "in_progress", "blocked"];

/**
 * The ticket a proxied call acts for: the one named (only its assignee may name it), or else
 * the caller's only open ticket. A sandbox session always has exactly one.
 */
const egressTicket = (caller: McpCaller, ticketId: string | undefined) =>
  Effect.gen(function* () {
    if (ticketId !== undefined) {
      yield* guardTicketAccess(ticketId, caller);
      return ticketId;
    }
    const tickets = yield* TicketRepository;
    const mine = (yield* tickets.listByStatus(WORKING)).filter((t) => t.workerId === caller.id);
    if (mine.length !== 1) {
      return yield* new EgressTicketUnknown({
        workerId: caller.id,
        message:
          mine.length === 0
            ? "This worker has no open ticket to act for."
            : "This worker has several open tickets: name one in the x-project-os-ticket header.",
      });
    }
    return mine[0]!.id;
  });

/**
 * The access token the credential proxy adds to a Worker's call to `provider`: the same token
 * `user_token` would hand out, but it stays on the Coordinator. Fails `NotConnected` (and asks
 * the person to `/connect`) like `user_token` does.
 */
export const egressAccessToken = (input: {
  readonly caller: McpCaller;
  readonly provider: ConnectionProvider;
  /** From the `x-project-os-ticket` header; optional for a sandbox session. */
  readonly ticketId?: string;
}) =>
  Effect.gen(function* () {
    const ticketId = yield* egressTicket(input.caller, input.ticketId);
    const token = yield* userTokenForTicket({ ticketId, provider: input.provider });
    return token.accessToken;
  });
