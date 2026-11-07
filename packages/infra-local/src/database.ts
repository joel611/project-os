import { Database } from "bun:sqlite";
import { migrationsFolder, SqliteRepositories } from "@project-os/db-sqlite";
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

/** Repository ports over `bun:sqlite`; migrates on start, closes the file on release. */
export const SqliteLive = (path: string) =>
  Layer.unwrap(
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => openLocalDb(path)),
        ({ sqlite }) => Effect.sync(() => sqlite.close()),
      ),
      ({ db }) => SqliteRepositories(db),
    ),
  );
