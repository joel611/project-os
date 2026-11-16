import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authPlugins } from "./src/auth-options.ts";

/**
 * Config for the Better Auth CLI, which generates the Drizzle schema (`bun run auth:generate`).
 * It only reads the options to pick tables and columns, so the database is never queried.
 */
export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  plugins: authPlugins([]),
});
