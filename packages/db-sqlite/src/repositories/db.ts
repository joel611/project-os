import { Context, Effect, Layer } from "effect";
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core";

/** Any Drizzle SQLite db: sync (`bun:sqlite`) or async (D1). */
export type SqliteDb = SQLiteAsyncDatabase<"sync" | "async", unknown>;

/**
 * The Drizzle database as a service, built once per platform from its own handle: `DrizzleBun`
 * (a file path, in infra-local) or `DrizzleD1` (the Worker's binding, in infra-cloudflare). The
 * repositories and Better Auth both take it, so they share one handle.
 */
export class DrizzleSqlite extends Context.Service<DrizzleSqlite, SqliteDb>()(
  "@project-os/db-sqlite/DrizzleSqlite",
) {
  /** An already-open database, such as a test's in-memory one. */
  static readonly from = (db: SqliteDb): Layer.Layer<DrizzleSqlite> =>
    Layer.succeed(DrizzleSqlite, db);
}

/** Run a query; driver failures are defects (the ports expose no DB error channel). */
export const q = <A>(f: () => A | PromiseLike<A>): Effect.Effect<A> =>
  Effect.promise(async () => f());
