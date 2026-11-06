import {
  TICKET_STATUSES,
  TicketOrigin,
  type ActivityFeed,
  type ChannelType,
  type TicketEvent,
} from "@project-os/contracts";
import { Effect, Schema } from "effect";
import { isTerminal } from "../../domain/ticket/index.ts";
import { workerStatus } from "../../domain/worker/index.ts";
import {
  Clock,
  ProjectSourceRepository,
  TicketRepository,
  WorkerRepository,
} from "../ports/index.ts";
import { channelTypeFor } from "./channels.ts";

/** Most events one activity read returns. */
export const ACTIVITY_EVENT_LIMIT = 200;
/** Without `since`, the first read looks back this far. */
export const ACTIVITY_LOOKBACK_MS = 15 * 60_000;

const decodeOrigin = Schema.decodeUnknownOption(TicketOrigin);
const originOf = (events: ReadonlyArray<TicketEvent>): TicketOrigin | null => {
  const created = events.find((e) => e.type === "created");
  if (!created) return null;
  const origin = decodeOrigin(created.payload);
  return origin._tag === "Some" ? origin.value : null;
};

/**
 * Tickets changed and events appended since `since` (inclusive), plus every Worker. Without
 * `since`, it returns the last few minutes and every ticket still in flight, as a baseline.
 */
export const readActivity = (input: { readonly since?: string; readonly staleAfterMs: number }) =>
  Effect.gen(function* () {
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const tickets = yield* TicketRepository;
    const sources = yield* ProjectSourceRepository;
    const workers = yield* WorkerRepository;
    const from = input.since ?? new Date(now.getTime() - ACTIVITY_LOOKBACK_MS).toISOString();

    const changed = (yield* tickets.listByStatus(TICKET_STATUSES)).filter(
      (t) => t.updatedAt >= from || (input.since === undefined && !isTerminal(t.status)),
    );
    const replyChannels = new Map<string, ChannelType | null>();
    const replyChannelOf = (projectId: string) =>
      Effect.gen(function* () {
        const known = replyChannels.get(projectId);
        if (known !== undefined) return known;
        const target = (yield* sources.listByProject(projectId)).find(
          (s) => s.isDefaultResponse && s.status === "active",
        );
        const channel = (target && channelTypeFor(target.type)) ?? null;
        replyChannels.set(projectId, channel);
        return channel;
      });
    const views = yield* Effect.forEach(changed, (t) =>
      Effect.gen(function* () {
        const events = yield* tickets.listEvents(t.id).pipe(Effect.orDie);
        return { ...t, origin: originOf(events), replyChannel: yield* replyChannelOf(t.projectId) };
      }),
    );

    const feed: ActivityFeed = {
      now: now.toISOString(),
      tickets: views,
      events: yield* tickets.listEventsSince(from, ACTIVITY_EVENT_LIMIT),
      workers: (yield* workers.list).map((w) => ({
        ...w,
        status: workerStatus(w, now, input.staleAfterMs),
      })),
    };
    return feed;
  });
