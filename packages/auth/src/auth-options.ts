import type { BetterAuthOptions } from "better-auth";
import { bearer, genericOAuth, type GenericOAuthConfig, oneTimeToken } from "better-auth/plugins";

/**
 * The options that decide Better Auth's tables: model names and plugins. The runtime instance
 * (`auth.ts`) and the CLI config (`auth.config.ts`, which generates the Drizzle schema in
 * `@project-os/db-sqlite`) both spread these, so the generated schema matches what runs.
 *
 * `auth_` prefixes keep the tables apart from the org `users` table.
 */
export const authModels = {
  user: { modelName: "auth_users" },
  session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "auth_verifications" },
} satisfies Partial<BetterAuthOptions>;

/** Plugins in one place; the OAuth provider list is the only runtime-dependent part. */
export const authPlugins = (oauthProviders: ReadonlyArray<GenericOAuthConfig>) => [
  genericOAuth({ config: [...oauthProviders] }),
  bearer(),
  // Hands a Google sign-in's session from the Coordinator's origin to the dashboard's.
  oneTimeToken({ disableClientRequest: true, storeToken: "hashed" }),
];
