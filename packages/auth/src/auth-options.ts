import { PERMISSION_STATEMENTS, ROLE_GRANTS, ROLES } from "@project-os/contracts";
import {
  admin,
  bearer,
  genericOAuth,
  type GenericOAuthConfig,
  oneTimeToken,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";

const ac = createAccessControl(PERMISSION_STATEMENTS);

/** The dashboard roles as Better Auth access-control roles; `ROLE_GRANTS` is the one table. */
export const accessRoles = {
  admin: ac.newRole({ ...ROLE_GRANTS.admin } as never),
  member: ac.newRole({ ...ROLE_GRANTS.member } as never),
} satisfies Record<(typeof ROLES)[number], unknown>;

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
  // Adds `user.role` (default `member`). Roles and permissions are enforced by the Coordinator's
  // route guard; the plugin's own `/admin/*` endpoints grant no role anything, so they stay shut.
  admin({ ac, roles: accessRoles, defaultRole: "member", adminRoles: ["admin"] }),
];
