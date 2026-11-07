import { Effect } from "effect";
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core";

/** Any Drizzle SQLite db: sync (`bun:sqlite`) or async (D1). */
export type SqliteDb = SQLiteAsyncDatabase<"sync" | "async", unknown>;

/** Run a query; driver failures are defects (the ports expose no DB error channel). */
export const q = <A>(f: () => A | PromiseLike<A>): Effect.Effect<A> =>
  Effect.promise(async () => f());
