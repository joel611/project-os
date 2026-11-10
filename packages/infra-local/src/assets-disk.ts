import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { BlobBackend } from "./assets.ts";

/** Keeps files under `dir`, one per key. Bun only (it streams through `Bun.file`). */
export const makeDiskBackend = (dir: string): BlobBackend => {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error(`key ${key} escapes the asset directory`);
    return path;
  };
  return {
    put: async (key, body) => {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      try {
        await Bun.write(path, new Response(body));
      } catch (err) {
        // A cut-off download must not leave half a file for `get` to serve.
        await rm(path, { force: true });
        throw err;
      }
    },
    get: async (key) => {
      const file = Bun.file(pathOf(key));
      if (!(await file.exists())) return undefined;
      return { body: file.stream(), contentType: file.type, size: file.size };
    },
  };
};
