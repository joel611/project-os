import { Effect } from "effect";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../schema/index.ts";

/** Any Drizzle SQLite db: sync (`bun:sqlite`) or async (D1). */
export type SqliteDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

/** Run a query; driver failures are defects (the ports expose no DB error channel). */
export const q = <A>(f: () => A | PromiseLike<A>): Effect.Effect<A> =>
  Effect.promise(async () => f());
