import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@project-os/db-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_ORG, ensureOrg, openLocalDb } from "./index.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infra-local-org-"));
  dbPath = join(dir, "test.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const orgs = () => {
  const { sqlite, db } = openLocalDb(dbPath);
  const rows = db.select().from(schema.orgs).all();
  sqlite.close();
  return rows;
};

describe("ensureOrg", () => {
  it("creates the default org on a fresh database", () => {
    expect(ensureOrg(dbPath)).toBe(DEFAULT_ORG.id);
    expect(orgs()).toMatchObject([{ id: DEFAULT_ORG.id, name: DEFAULT_ORG.name }]);
  });

  it("is idempotent", () => {
    ensureOrg(dbPath);
    ensureOrg(dbPath);
    expect(orgs()).toHaveLength(1);
  });

  it("creates a custom org without touching the default", () => {
    ensureOrg(dbPath, { id: "o2", name: "Other" });
    expect(orgs().map((o) => o.id)).toEqual(["o2"]);
  });
});
