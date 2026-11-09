import { schema } from "@project-os/db-sqlite";
import { openLocalDb } from "./database.ts";
import { DEFAULT_ORG } from "./shared.ts";

export { DEFAULT_ORG };

/**
 * Creates the org if missing (migrating the database first). Idempotent. Run it before the
 * runtime starts, since projects reference `orgs.id`. Returns the org id.
 */
export const ensureOrg = (
  dbPath: string,
  org: { readonly id: string; readonly name: string } = DEFAULT_ORG,
): string => {
  const { sqlite, db } = openLocalDb(dbPath);
  try {
    db.insert(schema.orgs)
      .values({ ...org, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
    return org.id;
  } finally {
    sqlite.close();
  }
};
