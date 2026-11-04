import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DATA_DIR, REPO_ROOT, dataPath } from "./data.ts";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("dataPath", () => {
  it("puts the repo-root .data directory next to the workspace package.json", () => {
    expect(DATA_DIR).toBe(resolve(REPO_ROOT, ".data"));
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
  });

  it("defaults to <repo>/.data/<file>, regardless of cwd, and creates the directory", () => {
    const p = dataPath("project-os.sqlite");
    expect(p).toBe(join(DATA_DIR, "project-os.sqlite"));
    expect(existsSync(DATA_DIR)).toBe(true);
  });

  it("uses an absolute override as is and creates its parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "po-data-"));
    tmp.push(dir);
    const target = join(dir, "nested", "db.sqlite");
    expect(dataPath("ignored.sqlite", target)).toBe(target);
    expect(existsSync(join(dir, "nested"))).toBe(true);
  });

  it("resolves a relative override against the repo root, not the cwd", () => {
    expect(dataPath("ignored.sqlite", ".data/custom.sqlite")).toBe(
      join(REPO_ROOT, ".data", "custom.sqlite"),
    );
  });

  it("treats an empty override (e.g. an unset compose variable) as no override", () => {
    expect(dataPath("pi-durable.sqlite", "")).toBe(join(DATA_DIR, "pi-durable.sqlite"));
  });
});
