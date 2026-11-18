import { Effect } from "effect";
import {
  type AuditLogRepository,
  type ChannelGateway,
  type Clock,
  type IdGenerator,
  type KeyValueStore,
  type ProjectSourceRepository,
  Sidekick,
  type SidekickToken,
  type TicketRepository,
  type UserConnections,
} from "../ports/index.ts";
import { userTokenForTicket } from "./connections.ts";

/** Worker id of tickets the Sidekick answers. The Watcher lists only its own id, so never sees them. */
export const SIDEKICK_WORKER_ID = "sidekick";

type TokenEnv =
  | TicketRepository
  | UserConnections
  | KeyValueStore
  | ProjectSourceRepository
  | ChannelGateway
  | AuditLogRepository
  | Clock
  | IdGenerator;

/**
 * One Sidekick turn on a ticket. Its tools get the token of whoever wrote the ticket's latest
 * message, the same one a Worker would get from `user_token`, so a follow-up from someone else
 * runs as them. A missing link comes back to the model as text, and `userTokenForTicket` has
 * already asked the person in the project's channel to `/connect`.
 */
export const askSidekick = (input: {
  readonly ticketId: string;
  readonly prompt: string;
  readonly requestId?: string;
}) =>
  Effect.gen(function* () {
    const sidekick = yield* Sidekick;
    const run = Effect.runPromiseWith(yield* Effect.context<TokenEnv>());
    return yield* sidekick.answer({
      ...input,
      token: (provider) =>
        run(
          userTokenForTicket({ ticketId: input.ticketId, provider }).pipe(
            Effect.map((t): SidekickToken => ({ ok: true, accessToken: t.accessToken })),
            Effect.catch((e) => Effect.succeed<SidekickToken>({ ok: false, message: e.message })),
          ),
        ),
    });
  });
