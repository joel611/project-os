import type { Run } from "@project-os/contracts";
import type { RunRepository } from "@project-os/core";
import { and, asc, eq, exists, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import { ticketRuns, tickets } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof RunRepository)["Service"];

const toRun = ({ assignedAt, ...run }: typeof ticketRuns.$inferSelect): Run =>
  assignedAt === null ? run : { ...run, stoppable: true };

const activeAssignment = and(
  inArray(tickets.status, ["assigned", "in_progress"]),
  eq(tickets.workerType, "local"),
  eq(tickets.workerId, ticketRuns.workerId),
  eq(tickets.assignedAt, ticketRuns.assignedAt),
);

export const makeRunRepository = (db: SqliteDb): Impl => ({
  get: (id) =>
    q(() => db.select().from(ticketRuns).where(eq(ticketRuns.id, id)).limit(1)).pipe(
      Effect.map((rows) => (rows[0] ? toRun(rows[0]) : undefined)),
    ),
  save: ({ stoppable: _stoppable, ...run }, assignedAt) =>
    q(() =>
      db
        .insert(ticketRuns)
        .values({ ...run, assignedAt: assignedAt ?? null })
        .onConflictDoUpdate({
          target: ticketRuns.id,
          set: {
            ...run,
            status: sql`case when ${ticketRuns.status} = 'stopped' then 'stopped' else ${run.status} end`,
            endedAt: sql`case when ${ticketRuns.status} = 'stopped' then ${ticketRuns.endedAt} else ${run.endedAt} end`,
            exitCode: sql`case when ${ticketRuns.status} = 'stopped' then null else ${run.exitCode} end`,
          },
        }),
    ).pipe(Effect.asVoid),
  requestStop: (ticketId, runId, at) =>
    q(() =>
      db
        .update(ticketRuns)
        .set({ status: "stopped", endedAt: at })
        .where(
          and(
            eq(ticketRuns.id, runId),
            eq(ticketRuns.ticketId, ticketId),
            eq(ticketRuns.status, "running"),
            exists(
              db
                .select({ id: tickets.id })
                .from(tickets)
                .where(and(eq(tickets.id, ticketId), activeAssignment)),
            ),
          ),
        )
        .returning({ id: ticketRuns.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
  listByTicket: (ticketId) =>
    q(() =>
      db
        .select({
          ...getTableColumns(ticketRuns),
          assignedAt: sql<
            string | null
          >`case when ${activeAssignment} then ${ticketRuns.assignedAt} end`,
        })
        .from(ticketRuns)
        .innerJoin(tickets, eq(tickets.id, ticketRuns.ticketId))
        .where(eq(ticketRuns.ticketId, ticketId))
        .orderBy(asc(ticketRuns.startedAt)),
    ).pipe(Effect.map((rows) => rows.map(toRun))),
  listStoredBefore: (at) =>
    q(() =>
      db
        .select()
        .from(ticketRuns)
        .where(and(lt(ticketRuns.startedAt, at), eq(ticketRuns.expired, false))),
    ).pipe(Effect.map((rows) => rows.map(toRun))),
});
