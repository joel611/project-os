import {
  ClaimConflict,
  TicketNotFound,
  transitionTicket,
  type Ticket,
  type TicketRepository,
} from "@project-os/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { ticketEvents, tickets } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof TicketRepository)["Service"];

export const makeTicketRepository = (db: SqliteDb): Impl => {
  const find = (id: string): Effect.Effect<Ticket, TicketNotFound> =>
    q(() => db.select().from(tickets).where(eq(tickets.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new TicketNotFound({ ticketId: id })),
      ),
    );

  const updateStatus: Impl["updateStatus"] = (ticketId, to, at, extra) =>
    find(ticketId).pipe(
      Effect.flatMap((current) =>
        transitionTicket(current, to, at, extra).pipe(
          Effect.flatMap((next) =>
            // Guard on the status we read, so a concurrent change can't be overwritten.
            q(() =>
              db
                .update(tickets)
                .set({
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
                row ? Effect.succeed(row) : updateStatus(ticketId, to, at, extra),
              ),
            ),
          ),
        ),
      ),
    );

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
  };
};
