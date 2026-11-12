import {
  ClaimConflict,
  InvalidTransition,
  releaseTicket,
  TicketNotFound,
  transitionTicket,
  type Ticket,
  type TicketStatus,
  type TicketRepository,
} from "@project-os/core";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { ticketEvents, tickets, ticketThreads } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof TicketRepository)["Service"];

export const makeTicketRepository = (db: SqliteDb): Impl => {
  const find = (id: string): Effect.Effect<Ticket, TicketNotFound> =>
    q(() => db.select().from(tickets).where(eq(tickets.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new TicketNotFound({ ticketId: id })),
      ),
    );

  type Extra = Parameters<Impl["updateStatus"]>[3];
  type Worker = Parameters<Impl["assign"]>[1];

  const transition = (
    ticketId: string,
    to: TicketStatus,
    at: string,
    extra: Extra,
    worker?: Worker,
  ): Effect.Effect<Ticket, TicketNotFound | InvalidTransition> =>
    find(ticketId).pipe(
      Effect.flatMap((current) =>
        transitionTicket(current, to, at, extra).pipe(
          Effect.flatMap((next) =>
            // Guard on the status we read, so a concurrent change can't be overwritten.
            q(() =>
              db
                .update(tickets)
                .set({
                  ...(worker && { workerType: worker.workerType, workerId: worker.workerId }),
                  status: next.status,
                  result: next.result,
                  error: next.error,
                  assignedAt: next.assignedAt,
                  startedAt: next.startedAt,
                  completedAt: next.completedAt,
                  lastActivityAt: next.lastActivityAt,
                  updatedAt: next.updatedAt,
                })
                .where(and(eq(tickets.id, ticketId), eq(tickets.status, current.status)))
                .returning(),
            ).pipe(
              Effect.flatMap(([row]) =>
                row ? Effect.succeed(row) : transition(ticketId, to, at, extra, worker),
              ),
            ),
          ),
        ),
      ),
    );

  const updateStatus: Impl["updateStatus"] = (ticketId, to, at, extra) =>
    transition(ticketId, to, at, extra);
  const assign: Impl["assign"] = (ticketId, worker, at) =>
    transition(ticketId, "assigned", at, undefined, worker);

  return {
    insert: (ticket) => q(() => db.insert(tickets).values(ticket)).pipe(Effect.as(ticket)),
    get: find,
    listAssigned: (workerId) =>
      q(() =>
        db
          .select()
          .from(tickets)
          .where(and(eq(tickets.status, "assigned"), eq(tickets.workerId, workerId)))
          .orderBy(
            asc(sql`coalesce(${tickets.assignedAt}, ${tickets.createdAt})`),
            asc(sql`rowid`),
          ),
      ),
    listByStatus: (statuses) =>
      statuses.length === 0
        ? Effect.succeed([])
        : q(() =>
            db
              .select()
              .from(tickets)
              .where(inArray(tickets.status, [...statuses])),
          ),
    assign,
    release: (ticketId, workerId, at) =>
      find(ticketId).pipe(
        Effect.flatMap((current) => releaseTicket(current, workerId, at)),
        Effect.flatMap((next) =>
          // One conditional UPDATE: only a ticket still `assigned` to this worker is taken back.
          q(() =>
            db
              .update(tickets)
              .set({
                status: "open",
                workerType: null,
                workerId: null,
                assignedAt: null,
                lastActivityAt: next.lastActivityAt,
                updatedAt: next.updatedAt,
              })
              .where(
                and(
                  eq(tickets.id, ticketId),
                  eq(tickets.status, "assigned"),
                  eq(tickets.workerId, workerId),
                ),
              )
              .returning(),
          ),
        ),
        Effect.flatMap(([row]) =>
          row
            ? Effect.succeed(row)
            : find(ticketId).pipe(
                Effect.flatMap((t) =>
                  Effect.fail(new InvalidTransition({ ticketId, from: t.status, to: "open" })),
                ),
              ),
        ),
      ),
    claim: (ticketId, workerId, at) =>
      // One conditional UPDATE: of N concurrent claims exactly one matches `status = 'assigned'`.
      q(() =>
        db
          .update(tickets)
          .set({ status: "in_progress", startedAt: at, lastActivityAt: at, updatedAt: at })
          .where(
            and(
              eq(tickets.id, ticketId),
              eq(tickets.status, "assigned"),
              eq(tickets.workerId, workerId),
            ),
          )
          .returning(),
      ).pipe(
        Effect.flatMap(([won]) =>
          won
            ? Effect.succeed(won)
            : find(ticketId).pipe(
                Effect.flatMap((t) =>
                  Effect.fail(
                    new ClaimConflict({
                      ticketId,
                      workerId,
                      status: t.status,
                      assignedTo: t.workerId,
                    }),
                  ),
                ),
              ),
        ),
      ),
    updateStatus,
    appendEvent: (event) =>
      find(event.ticketId).pipe(
        Effect.andThen(q(() => db.insert(ticketEvents).values(event))),
        Effect.andThen(
          q(() =>
            db
              .update(tickets)
              .set({ lastActivityAt: event.createdAt, updatedAt: event.createdAt })
              .where(eq(tickets.id, event.ticketId)),
          ),
        ),
        Effect.as(event),
      ),
    listEvents: (ticketId, limit) =>
      find(ticketId).pipe(
        Effect.andThen(
          q(() =>
            db
              .select()
              .from(ticketEvents)
              .where(eq(ticketEvents.ticketId, ticketId))
              .orderBy(desc(ticketEvents.createdAt), desc(sql`rowid`))
              .limit(limit ?? -1),
          ),
        ),
        // Newest-N selected above; return chronological like the in-memory fake.
        Effect.map((rows) => rows.reverse()),
      ),
    linkThread: (thread) =>
      find(thread.ticketId).pipe(
        Effect.andThen(q(() => db.insert(ticketThreads).values(thread))),
        Effect.as(thread),
      ),
    findThread: (ticketId) =>
      q(() => db.select().from(ticketThreads).where(eq(ticketThreads.ticketId, ticketId))).pipe(
        Effect.map(([row]) => row),
      ),
    findByThread: (channelType, threadId) =>
      q(() =>
        db
          .select()
          .from(ticketThreads)
          .where(
            and(eq(ticketThreads.channelType, channelType), eq(ticketThreads.threadId, threadId)),
          ),
      ).pipe(Effect.map(([row]) => row)),
    listEventsSince: (since, limit) =>
      q(() =>
        db
          .select()
          .from(ticketEvents)
          .where(gte(ticketEvents.createdAt, since))
          .orderBy(desc(ticketEvents.createdAt), desc(sql`rowid`))
          .limit(limit),
      ).pipe(Effect.map((rows) => rows.reverse())),
  };
};
