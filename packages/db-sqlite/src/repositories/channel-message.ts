import type { ChannelMessageRepository } from "@project-os/core";
import { asc, count, eq, inArray, lt, max, min, sql } from "drizzle-orm";
import { Effect } from "effect";
import { channelMessages } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof ChannelMessageRepository)["Service"];

/** D1 caps bound parameters per statement; delete in chunks below it. */
const DELETE_CHUNK = 90;

export const makeChannelMessageRepository = (db: SqliteDb): Impl => ({
  append: (message) =>
    q(() =>
      db
        .insert(channelMessages)
        .values(message)
        .onConflictDoNothing()
        .returning({ id: channelMessages.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
  pending: q(() =>
    db
      .select({
        projectId: channelMessages.projectId,
        count: count(),
        oldestAt: min(channelMessages.sentAt),
        newestAt: max(channelMessages.sentAt),
      })
      .from(channelMessages)
      .groupBy(channelMessages.projectId),
  ).pipe(
    Effect.map((rows) =>
      rows.map((r) => ({
        projectId: r.projectId,
        count: r.count,
        oldestAt: r.oldestAt ?? "",
        newestAt: r.newestAt ?? "",
      })),
    ),
  ),
  list: (projectId, limit) =>
    q(() =>
      db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.projectId, projectId))
        .orderBy(asc(channelMessages.sentAt), asc(sql`rowid`))
        .limit(limit),
    ),
  remove: (ids) =>
    Effect.forEach(
      Array.from({ length: Math.ceil(ids.length / DELETE_CHUNK) }, (_, i) =>
        ids.slice(i * DELETE_CHUNK, (i + 1) * DELETE_CHUNK),
      ),
      (chunk) => q(() => db.delete(channelMessages).where(inArray(channelMessages.id, chunk))),
      { discard: true },
    ),
  removeSentBefore: (at) =>
    q(() =>
      db
        .delete(channelMessages)
        .where(lt(channelMessages.sentAt, at))
        .returning({ id: channelMessages.id }),
    ).pipe(Effect.map((rows) => rows.length)),
});
