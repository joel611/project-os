import { schema } from "@project-os/db-sqlite";
import { openLocalDb } from "./database.ts";

/** The single org of the POC. Projects need one (FK), and no use case creates orgs. */
export const DEFAULT_ORG = { id: "default-org", name: "Default Org" } as const;

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
