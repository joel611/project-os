import type { Run } from "@project-os/contracts";
import type { RunRepository } from "@project-os/core";
import { and, asc, eq, lt } from "drizzle-orm";
import { Effect } from "effect";
import { ticketRuns } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof RunRepository)["Service"];

const toRun = (row: typeof ticketRuns.$inferSelect): Run => row;

export const makeRunRepository = (db: SqliteDb): Impl => ({
  get: (id) =>
    q(() => db.select().from(ticketRuns).where(eq(ticketRuns.id, id)).limit(1)).pipe(
      Effect.map((rows) => (rows[0] ? toRun(rows[0]) : undefined)),
    ),
  save: (run) =>
    q(() =>
      db.insert(ticketRuns).values(run).onConflictDoUpdate({ target: ticketRuns.id, set: run }),
    ).pipe(Effect.asVoid),
  listByTicket: (ticketId) =>
    q(() =>
      db
        .select()
        .from(ticketRuns)
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
