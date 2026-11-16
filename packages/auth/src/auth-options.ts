import { bearer, genericOAuth, type GenericOAuthConfig, oneTimeToken } from "better-auth/plugins";

/**
 * Plugins decide Better Auth's tables. The runtime instance (`auth.ts`) and the CLI config
 * (`auth.config.ts`, which generates the Drizzle schema in `@project-os/db-sqlite`) both use
 * them, so the generated schema matches what runs. The OAuth provider list is the only
 * runtime-dependent part.
 */
export const authPlugins = (oauthProviders: ReadonlyArray<GenericOAuthConfig>) => [
  genericOAuth({ config: [...oauthProviders] }),
  bearer(),
  // Hands a Google sign-in's session from the Coordinator's origin to the dashboard's.
  oneTimeToken({ disableClientRequest: true, storeToken: "hashed" }),
];
