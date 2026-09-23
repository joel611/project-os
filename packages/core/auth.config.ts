/**
 * CLI-only Better Auth config. Not used at runtime — `Auth`
 * (src/libs/auth/auth.ts) is the real, Effect-wired service. This file builds
 * the same `@better-auth/drizzle-adapter/relations-v2` adapter over a
 * throwaway D1 driver (never connected — `generate` only inspects the schema
 * shape, it never runs a query) so the Better Auth CLI
 * (`bunx auth@latest generate`) has a plain, synchronously constructible
 * `auth` export.
 *
 * `src/libs/auth/auth-schema.ts` is the CLI's output — regenerate it in place
 * after adding a plugin that adds tables:
 *
 *   bun run auth:generate
 *
 * Then clean up the CLI cruft noted atop `auth-schema.ts` (`@__PURE__`
 * annotations). `src/libs/db/schema.ts` re-exports the tables alongside
 * `task`, so run `bun run db:generate` (from `packages/core`) to turn the
 * schema change into a migration.
 *
 * No `schema` option is passed to `drizzleAdapter` here (unlike the runtime
 * `Auth` service in `src/libs/auth/auth.ts`): the CLI loads this file with
 * its own bundled `drizzle-orm`, which doesn't have to match the workspace's
 * pinned rc build, so importing the generated `auth-schema.ts` back into
 * this file risks the same kind of version skew. `generate` only needs
 * `provider: "sqlite"` to pick a dialect; it doesn't read the adapter's
 * schema.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";

import { authOptions } from "./src/libs/auth/auth";

const db = drizzle({} as D1Database);

export const auth = betterAuth({
  ...authOptions,
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  secret: process.env.BETTER_AUTH_SECRET,
});
