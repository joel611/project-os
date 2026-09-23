import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Miniflare } from "miniflare";

const migrationsDir = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "drizzle"
);

const migrationStatements = () =>
  readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      readFileSync(
        path.join(migrationsDir, entry.name, "migration.sql"),
        "utf-8"
      )
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean)
    );

export const makeTestD1 = async () => {
  const mf = new Miniflare({
    d1Databases: ["DB"],
    modules: true,
    script: "",
  });

  const binding = await mf.getD1Database("DB");
  for (const statement of migrationStatements()) {
    // oxlint-disable-next-line no-await-in-loop -- migrations must apply in file order
    await binding.prepare(statement).run();
  }

  return {
    binding,
    dispose: () => mf.dispose(),
  };
};
