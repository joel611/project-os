/**
 * Absolute path of the shared migrations, for providers to apply on start. A separate subpath
 * because `import.meta.url` is not a file URL on Workers, so the package root can't build it
 * at module load. D1 gets its migrations from the deploy instead.
 */
export const migrationsFolder = new URL("../migrations", import.meta.url).pathname;
