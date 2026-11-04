import type { MemoryRepository } from "@project-os/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { memoryEntries } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof MemoryRepository)["Service"];

const NEWEST_FIRST = [desc(memoryEntries.createdAt), desc(sql`rowid`)] as const;

export const makeMemoryRepository = (db: SqliteDb): Impl => ({
  insert: (entry) => q(() => db.insert(memoryEntries).values(entry)).pipe(Effect.as(entry)),
  list: (projectId, options) =>
    q(() =>
      db
        .select()
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.projectId, projectId),
            options?.type === undefined ? undefined : eq(memoryEntries.type, options.type),
          ),
        )
        .orderBy(...NEWEST_FIRST)
        .limit(options?.limit ?? -1),
    ),
  search: (projectId, query, limit) =>
    q(() =>
      db
        .select()
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.projectId, projectId),
            // instr avoids LIKE wildcard escaping; lower() makes it case-insensitive.
            sql`instr(lower(${memoryEntries.title} || char(10) || ${memoryEntries.content}), lower(${query})) > 0`,
          ),
        )
        .orderBy(...NEWEST_FIRST)
        .limit(limit ?? -1),
    ),
});
