import type { AuditLogRepository } from "@project-os/core";
import type { AuditEntry } from "@project-os/contracts";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";
import { auditLog } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof AuditLogRepository)["Service"];
type Row = typeof auditLog.$inferSelect;

/** Append order: entries are read newest-logged first, whatever their `at`. */
const ROWID = sql<number>`${auditLog}.rowid`;

const toEntry = (row: Row): AuditEntry => ({
  id: row.id,
  at: row.at,
  kind: row.kind,
  action: row.action,
  actorType: row.actorType,
  actorId: row.actorId,
  actorName: row.actorName,
  projectId: row.projectId,
  ticketId: row.ticketId,
  workerId: row.workerId,
  summary: row.summary,
  payload: row.payload ?? null,
});

export const makeAuditLogRepository = (db: SqliteDb): Impl => ({
  append: (entry, dedupeKey) =>
    q(() =>
      db
        .insert(auditLog)
        .values({ ...entry, dedupeKey: dedupeKey ?? null })
        .onConflictDoNothing()
        .returning({ id: auditLog.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
  list: ({ projectId, kind, before, limit }) => {
    const where: SQL[] = [];
    if (projectId !== undefined) where.push(eq(auditLog.projectId, projectId));
    if (kind !== undefined) where.push(eq(auditLog.kind, kind));
    if (before !== undefined) where.push(lt(ROWID, before));
    return q(() =>
      db
        .select({ row: auditLog, seq: ROWID })
        .from(auditLog)
        .where(and(...where))
        .orderBy(desc(ROWID))
        .limit(limit),
    ).pipe(
      Effect.map((rows) => ({
        entries: rows.map((r) => toEntry(r.row)),
        next: rows.length < limit ? null : rows.at(-1)!.seq,
      })),
    );
  },
  removeBefore: (at) =>
    q(() => db.delete(auditLog).where(lt(auditLog.at, at)).returning({ id: auditLog.id })).pipe(
      Effect.map((rows) => rows.length),
    ),
});
