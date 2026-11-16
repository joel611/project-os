import { Database } from "bun:sqlite";
import { DrizzleSqlite, SqliteRepositories } from "@project-os/db-sqlite";
import { migrationsFolder } from "@project-os/db-sqlite/migrations-folder";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect, Layer } from "effect";

/** Opens the SQLite file (created if missing), enables FKs, and applies migrations. */
export const openLocalDb = (path: string) => {
  const sqlite = new Database(path, { create: true });
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder });
  return { sqlite, db };
};

/** The Drizzle db over `bun:sqlite`; migrates on start, closes the file on release. */
export const DrizzleBun = (path: string): Layer.Layer<DrizzleSqlite> =>
  Layer.effect(
    DrizzleSqlite,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => openLocalDb(path)),
        ({ sqlite }) => Effect.sync(() => sqlite.close()),
      ),
      ({ db }) => db,
    ),
  );

/** Repository ports over `bun:sqlite`. */
export const SqliteLive = (path: string) =>
  SqliteRepositories.pipe(Layer.provide(DrizzleBun(path)));
