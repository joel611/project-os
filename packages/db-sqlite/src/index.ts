export * as schema from "./schema/index.ts";
export * from "./repositories/index.ts";

/** Absolute path of the shared migrations, for providers to apply on start. */
export const migrationsFolder = new URL("../migrations", import.meta.url).pathname;
