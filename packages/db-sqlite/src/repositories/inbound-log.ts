import type { InboundLogRepository } from "@project-os/core";
import { desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { inboundLog } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof InboundLogRepository)["Service"];

export const makeInboundLogRepository = (db: SqliteDb): Impl => ({
  append: (entry) =>
    q(() =>
      db.insert(inboundLog).values(entry).onConflictDoNothing().returning({ id: inboundLog.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
  list: (projectId, limit) =>
    q(() =>
      db
        .select()
        .from(inboundLog)
        .where(eq(inboundLog.projectId, projectId))
        .orderBy(desc(inboundLog.receivedAt), desc(sql`rowid`))
        .limit(limit),
    ),
});
