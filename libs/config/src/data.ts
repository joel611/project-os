import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Local data files (SQLite) live in <repo>/.data, whatever directory the app starts in.
// Kept out of the package index so Worker bundles never pull in node:fs.

/** Repo root: this file is libs/config/src/data.ts. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const DATA_DIR = resolve(REPO_ROOT, ".data");

/**
 * Absolute path for a data file. A non-empty `override` (an env value) wins; a relative
 * override resolves against the repo root, so the cwd never matters. Creates the parent
 * directory because SQLite will not.
 */
export const dataPath = (file: string, override?: string): string => {
  const path = override ? resolve(REPO_ROOT, override) : resolve(DATA_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  return path;
};
