import type { SessionUser } from "@project-os/auth";

/** Who a request's `Authorization: Bearer` credentials say is calling. */
export type Caller =
  | { readonly kind: "anonymous" }
  /** A dashboard session whose email is on the allowlist. */
  | { readonly kind: "user"; readonly userId: string }
  /** A valid session for someone not on the allowlist, such as a person's channel identity. */
  | { readonly kind: "outsider" }
  /** A Channel Adapter holding COORDINATOR_SERVICE_TOKEN. */
  | { readonly kind: "service" };

/**
 * Who may call a route. `worker` is /mcp: Watchers and sandbox sessions, whose credentials the
 * MCP route resolves itself.
 */
export type RoutePolicy = "public" | "user" | "service" | "worker";

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
  // GET only shows a confirm page; the POST redeems the one-time token.
  "GET /connect/:token": "public",
  "POST /connect/:token": "public",
  // The signature in the link is the proof; it covers one file and expires.
  "GET /assets/:ticketId/:attachmentId/:filename": "public",
  // The one-time code is the proof; the install script holds nothing secret.
  "POST /workers/register": "public",
  "GET /watcher/install.sh": "public",
  // Channel Adapters: admin identity in the body is trusted only from them.
  "POST /inbound": "service",
  "POST /commands": "service",
  "POST /prompts/answer": "service",
  "ALL /mcp": "worker",
  "GET /projects": "user",
  "POST /projects": "user",
  "GET /projects/:id": "user",
  "PATCH /projects/:id": "user",
  "GET /projects/:id/memory": "user",
  "POST /projects/:id/sources": "user",
  "PATCH /projects/:id/sources/:sourceId": "user",
  "GET /projects/:id/tickets": "user",
  "GET /workers": "user",
  "GET /activity": "user",
  "GET /tickets/:id": "user",
  "GET /tickets/:id/attachments": "user",
  "POST /tickets/:id/status": "user",
};

export const policyFor = (method: string, route: string): RoutePolicy =>
  ROUTE_POLICY[`${method} ${route}`] ?? ROUTE_POLICY[`ALL ${route}`] ?? "user";

const ADMITS: Readonly<Record<RoutePolicy, ReadonlyArray<Caller["kind"]>>> = {
  public: ["anonymous", "user", "outsider", "service"],
  worker: ["anonymous", "user", "outsider", "service"],
  user: ["user"],
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

/** Compares digests in full, so the time taken says nothing about where they differ. */
const sameSecret = async (a: string, b: string) => {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};

/** Resolves who is calling; the guard in app.ts asks only for routes that need someone. */
export interface Access {
  readonly caller: (request: Request) => Promise<Caller>;
}

export const makeAccess = (deps: {
  readonly serviceToken: string;
  readonly auth: {
    readonly sessionUser: (token: string) => Promise<SessionUser | undefined>;
    readonly isAllowed: (email: string) => boolean;
  };
}): Access => ({
  caller: async (request) => {
    const token = bearerToken(request);
    if (!token) return { kind: "anonymous" };
    if (await sameSecret(token, deps.serviceToken)) return { kind: "service" };
    const user = await deps.auth.sessionUser(token);
    if (!user) return { kind: "anonymous" };
    return deps.auth.isAllowed(user.email)
      ? { kind: "user", userId: user.userId }
      : { kind: "outsider" };
  },
});

/** The denial for this request, if any. Public and MCP routes never resolve the caller. */
export const deny = async (
  access: Access,
  request: Request,
  route: string,
): Promise<Denial | undefined> => {
  const policy = policyFor(request.method, route);
  if (policy === "public" || policy === "worker") return undefined;
  return authorize(policy, await access.caller(request));
};
