import type { SessionUser } from "@project-os/auth";
import type { Person } from "@project-os/core";

/**
 * Who a request's `Authorization: Bearer` credentials say is calling. A `user` is an Operator; a
 * `member` is a channel person signed in with the Google account they linked, who sees only
 * the Tickets they are involved in.
 */
export type Caller =
  | { readonly kind: "anonymous" }
  | { readonly kind: "user"; readonly userId: string; readonly name: string }
  | { readonly kind: "member"; readonly userId: string; readonly person: Person }
  | { readonly kind: "outsider" }
  | { readonly kind: "service" };

/**
 * Who may call a route. `worker` is /mcp: Watchers and sandbox sessions, whose credentials the
 * MCP route resolves itself. `token` routes carry their own proof (a signed link, a one-time
 * token) that the handler redeems. `member` routes take Operators and members alike, and the
 * handler narrows what a member sees to their own Tickets.
 */
export type RoutePolicy = "public" | "token" | "user" | "member" | "service" | "worker";

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
  "GET /projects": "user",
  "POST /projects": "user",
  "GET /projects/:id": "user",
  "PATCH /projects/:id": "user",
  "GET /projects/:id/memory": "user",
  "GET /projects/:id/audit": "user",
  "GET /audit": "user",
  "POST /projects/:id/sources": "user",
  "PATCH /projects/:id/sources/:sourceId": "user",
  "DELETE /projects/:id/sources/:sourceId": "user",
  "GET /projects/:id/tickets": "user",
  "GET /workers": "user",
  "GET /activity": "user",
  "GET /me": "member",
  "GET /me/tickets": "member",
  "GET /tickets/:id": "member",
  "GET /tickets/:id/attachments": "member",
  "POST /tickets/:id/status": "user",
};

export const policyFor = (method: string, route: string): RoutePolicy =>
  ROUTE_POLICY[`${method} ${route}`] ?? ROUTE_POLICY[`ALL ${route}`] ?? "user";

const ADMITS: Readonly<Record<RoutePolicy, ReadonlyArray<Caller["kind"]>>> = {
  public: ["anonymous", "user", "outsider", "service"],
  token: ["anonymous", "user", "outsider", "service"],
  worker: ["anonymous", "user", "outsider", "service"],
  user: ["user"],
  member: ["user", "member"],
  service: ["service"],
};

export interface Denial {
  readonly status: 401 | 403;
  readonly error: "Unauthorized" | "Forbidden";
}

/** Undefined when `caller` may use a route with `policy`. */
export const authorize = (policy: RoutePolicy, caller: Caller): Denial | undefined => {
  if (ADMITS[policy].includes(caller.kind)) return undefined;
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
      return { kind: "user", userId: user.userId, name: user.name };
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
