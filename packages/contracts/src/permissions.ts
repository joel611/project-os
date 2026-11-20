import { Schema } from "effect";

/**
 * Dashboard roles and what each may do, as plain data so the Coordinator (which enforces it
 * through Better Auth's access control) and the dashboard (which hides what a role can't use)
 * read the same table. Resources are the things the dashboard shows; actions are what a person
 * may do to them.
 *
 * `ticket:read-own` is a Ticket the person is involved in; `ticket:read` is any Ticket.
 */
export const PERMISSION_STATEMENTS = {
  ticket: ["read-own", "read", "update"],
  project: ["read", "create", "update"],
  source: ["create", "update", "delete"],
  worker: ["read"],
  skillSet: ["read", "create", "update", "delete"],
  sharedAccount: ["read", "create", "delete", "assign"],
  member: ["read", "update"],
  audit: ["read"],
} as const;

export type Resource = keyof typeof PERMISSION_STATEMENTS;
export type Action<R extends Resource = Resource> = (typeof PERMISSION_STATEMENTS)[R][number];

export const ROLES = ["admin", "member"] as const;
export const Role = Schema.Literals(ROLES);
export type Role = typeof Role.Type;

/** What a role is granted: a subset of `PERMISSION_STATEMENTS`. */
export type Grants = { readonly [R in Resource]?: ReadonlyArray<Action<R>> };

export const ROLE_GRANTS: Readonly<Record<Role, Grants>> = {
  admin: PERMISSION_STATEMENTS,
  // A member sees only the Tickets they are involved in.
  member: { ticket: ["read-own"] },
};

export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as ReadonlyArray<string>).includes(value);

/** A role's grants as the dashboard receives them (`GET /me`). */
export const PermissionMap = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type PermissionMap = typeof PermissionMap.Type;

/** Whether `grants` allow `action` on `resource`. */
export const allows = <R extends Resource>(
  grants: Readonly<Record<string, ReadonlyArray<string>>> | Grants,
  resource: R,
  action: Action<R>,
): boolean =>
  Object.hasOwn(grants, resource) &&
  (grants as Readonly<Record<string, ReadonlyArray<string>>>)[resource]!.includes(action);

/** Whether `role` may do `action` on `resource`. */
export const can = <R extends Resource>(role: Role, resource: R, action: Action<R>): boolean =>
  allows(ROLE_GRANTS[role], resource, action);
