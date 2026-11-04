import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * Pi's SQLite storage on a file (config). Uses `node:sqlite`, which Bun supports.
 * One process owns the file at a time.
 */
export const openLocalStorage = (file: string) => openNodeSqliteStorage(file);
