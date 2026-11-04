import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";
import * as schema from "./index.ts";

const tables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[];

describe("schema foreign keys", () => {
  it("every foreign key resolves to a table in the schema", () => {
    const names = new Set(tables.map((t) => getTableConfig(t).name));
    const refs = tables.flatMap((t) => getTableConfig(t).foreignKeys);
    expect(refs.length).toBeGreaterThan(0);
    for (const fk of refs) {
      const ref = fk.reference();
      expect(names.has(getTableConfig(ref.foreignTable).name)).toBe(true);
      expect(ref.columns.length).toBe(ref.foreignColumns.length);
    }
  });
});
