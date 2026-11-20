import type { SessionUser } from "@project-os/auth";
import { type Action, can, type Resource, type Role } from "@project-os/contracts";
import type { Person } from "@project-os/core";

/**
 * Who a request's `Authorization: Bearer` credentials say is calling. A `user` is an Operator
 * with a dashboard `role`; a `member` is a channel person signed in with the Google account they
 * linked, who sees only the Tickets they are involved in (the `member` role).
 */
export type Caller =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly name: string;
      readonly role: Role;
    }
  | { readonly kind: "member"; readonly userId: string; readonly person: Person }
  | { readonly kind: "outsider" }
  | { readonly kind: "service" };

/** A route that needs a dashboard user whose role grants `action` on `resource`. */
export interface Permission<R extends Resource = Resource> {
  readonly resource: R;
  readonly action: Action<R>;
}

const needs = <R extends Resource>(resource: R, action: Action<R>): Permission => ({
  resource,
  action,
});

/**
 * Who may call a route. `worker` is /mcp: Watchers and sandbox sessions, whose credentials the
 * MCP route resolves itself. `token` routes carry their own proof (a signed link, a one-time
 * token) that the handler redeems. `member` routes take any signed-in dashboard user or member,
 * and the handler narrows what a caller without `ticket:read` sees to their own Tickets. A
 * `Permission` admits a dashboard user whose role grants it.
 */
export type RoutePolicy =
  | "public"
  | "token"
  | "user"
  | "member"
  | "service"
  | "worker"
  | Permission;

/**
 * Every route's policy, keyed `METHOD pattern` as registered (`ALL` for `.all`). A route missing
 * here needs a dashboard user; app.test.ts fails until it is listed.
 */
export const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> = {
  "GET /health": "public",
  "ALL /api/auth/*": "public",
  "GET /sign-in/providers": "public",
  "GET /sign-in/google": "public",
  "GET /sign-in/done": "public",
  "GET /connect/done": "public",
  "GET /connect/:token": "public",
  "POST /connect/:token": "token",
  "GET /assets/:ticketId/:attachmentId/:filename": "token",
  "PUT /assets/:ticketId/:attachmentId/:filename": "token",
  "POST /workers/register": "token",
  "GET /watcher/install.sh": "public",
  "POST /inbound": "service",
  "POST /commands": "service",
  "POST /prompts/answer": "service",
  "ALL /mcp": "worker",
  "ALL /egress/:service/*": "worker",
  "GET /tickets/:id/skills": "worker",
  "GET /tickets/:id/task-type": "worker",
  "GET /task-types": needs("taskType", "read"),
  "POST /task-types": needs("taskType", "create"),
  "GET /task-types/:id": needs("taskType", "read"),
  "PATCH /task-types/:id": needs("taskType", "update"),
  "DELETE /task-types/:id": needs("taskType", "delete"),
  "POST /task-types/browse": needs("taskType", "create"),
  "POST /task-types/:id/skills": needs("taskType", "update"),
  "DELETE /task-types/:id/skills/:skillId": needs("taskType", "update"),
  "GET /task-types/:id/updates": needs("taskType", "read"),
  "POST /task-types/:id/update": needs("taskType", "update"),
  "GET /projects": needs("project", "read"),
  "POST /projects": needs("project", "create"),
  "GET /projects/:id": needs("project", "read"),
  "PATCH /projects/:id": needs("project", "update"),
  "GET /projects/:id/memory": needs("project", "read"),
  "GET /projects/:id/audit": needs("audit", "read"),
  "GET /audit": needs("audit", "read"),
  "POST /projects/:id/sources": needs("source", "create"),
  "PATCH /projects/:id/sources/:sourceId": needs("source", "update"),
  "DELETE /projects/:id/sources/:sourceId": needs("source", "delete"),
  "GET /projects/:id/tickets": needs("ticket", "read"),
  "GET /members": needs("member", "read"),
  "POST /members/:key/role": needs("member", "update"),
  "GET /shared-accounts": needs("sharedAccount", "read"),
  "POST /shared-accounts": needs("sharedAccount", "create"),
  "POST /shared-accounts/:id/connect": needs("sharedAccount", "create"),
  "DELETE /shared-accounts/:id": needs("sharedAccount", "delete"),
  "POST /shared-accounts/assignments": needs("sharedAccount", "assign"),
  "GET /workers": needs("worker", "read"),
  "GET /workers/:id": needs("worker", "read"),
  "GET /workers/:id/audit": needs("audit", "read"),
  "GET /activity": needs("project", "read"),
  "GET /me": "member",
  "GET /me/tickets": "member",
  "GET /tickets/:id": "member",
  "GET /tickets/:id/attachments": "member",
  "POST /tickets/:id/status": needs("ticket", "update"),
  "POST /tickets/:id/assign": needs("ticket", "update"),
};

export const policyFor = (method: string, route: string): RoutePolicy =>
  ROUTE_POLICY[`${method} ${route}`] ?? ROUTE_POLICY[`ALL ${route}`] ?? "user";

const ADMITS: Readonly<Record<Exclude<RoutePolicy, Permission>, ReadonlyArray<Caller["kind"]>>> = {
  public: ["anonymous", "user", "outsider", "service"],
  token: ["anonymous", "user", "outsider", "service"],
  worker: ["anonymous", "user", "outsider", "service"],
  // A route nobody listed: dashboard admins only, so a new route is closed until someone decides.
  user: ["user"],
  member: ["user", "member"],
  service: ["service"],
};

export interface Denial {
  readonly status: 401 | 403;
  readonly error: "Unauthorized" | "Forbidden";
}

/** The role a caller acts with: a dashboard user's own, `member` for a channel member. */
export const roleOf = (caller: Caller): Role | undefined =>
  caller.kind === "user" ? caller.role : caller.kind === "member" ? "member" : undefined;

/** Undefined when `caller` may use a route with `policy`. */
export const authorize = (policy: RoutePolicy, caller: Caller): Denial | undefined => {
  const allowed =
    typeof policy === "object"
      ? caller.kind === "user" && can(caller.role, policy.resource, policy.action)
      : ADMITS[policy].includes(caller.kind) &&
        (policy !== "user" || (caller.kind === "user" && caller.role === "admin"));
  if (allowed) return undefined;
  return caller.kind === "anonymous"
    ? { status: 401, error: "Unauthorized" }
    : { status: 403, error: "Forbidden" };
};

export const bearerToken = (request: Request): string | undefined => {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
};

const sha256 = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

const sameSecret = async (a: string, b: string) => {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};

export interface Access {
  /** Resolved once per request: the route guard and the handler share the answer. */
  readonly caller: (request: Request) => Promise<Caller>;
  /**
   * The channel person whose Tickets count as the caller's own: a member's identity, or the one
   * an Operator's Google sign-in is linked to. Undefined for anyone else.
   */
  readonly personOf: (caller: Caller) => Promise<Person | undefined>;
}

export const makeAccess = (deps: {
  readonly serviceToken: string;
  readonly auth: {
    readonly sessionUser: (token: string) => Promise<SessionUser | undefined>;
    readonly isAllowed: (email: string) => boolean;
    /** The channel person a non-Operator signs in as. Omitted: nobody but Operators. */
    readonly memberPerson?: (user: SessionUser) => Promise<Person | undefined>;
    /** The channel person an Operator's sign-in is linked to. */
    readonly linkedPerson?: (userId: string) => Promise<Person | undefined>;
  };
}): Access => {
  const resolve = async (request: Request): Promise<Caller> => {
    const token = bearerToken(request);
    if (!token) return { kind: "anonymous" };
    if (await sameSecret(token, deps.serviceToken)) return { kind: "service" };
    const user = await deps.auth.sessionUser(token);
    if (!user) return { kind: "anonymous" };
    if (deps.auth.isAllowed(user.email)) {
      return { kind: "user", userId: user.userId, name: user.name, role: user.role };
    }
    const person = await deps.auth.memberPerson?.(user);
    return person ? { kind: "member", userId: user.userId, person } : { kind: "outsider" };
  };
  const seen = new WeakMap<Request, Promise<Caller>>();
  return {
    caller: (request) => {
      let found = seen.get(request);
      if (!found) seen.set(request, (found = resolve(request)));
      return found;
    },
    personOf: async (caller) => {
      if (caller.kind === "member") return caller.person;
      if (caller.kind === "user") return deps.auth.linkedPerson?.(caller.userId);
      return undefined;
    },
  };
};

export const deny = async (
  access: Access,
  request: Request,
  route: string,
): Promise<Denial | undefined> => {
  const policy = policyFor(request.method, route);
  if (policy === "public" || policy === "token" || policy === "worker") return undefined;
  return authorize(policy, await access.caller(request));
};
