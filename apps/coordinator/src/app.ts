import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { type AuthDeps, authRoutes } from "./auth/routes.ts";
import { type ConnectDeps, connectRoutes } from "./connect/routes.ts";
import { httpRoutes, type HttpDeps } from "./http/routes.ts";
import { mcpRoutes, type McpRuntime } from "./mcp/server.ts";

export interface AppDeps {
  /** HTTP ingress + admin routes (#13). Omitted: no ingress routes. */
  readonly http?: HttpDeps;
  /** MCP server (#12). Omitted: `/mcp` is not mounted. */
  readonly mcp?: McpRuntime;
  /** Sign-in (`/api/auth/*`). Omitted: not mounted. */
  readonly auth?: AuthDeps;
  /** Account linking (`/connect/*`). Omitted: not mounted. */
  readonly connect?: ConnectDeps;
  /**
   * Origins a browser may call this API from (the web dashboard when it is served from
   * another origin). Omitted or empty: no CORS headers, so browsers block cross-origin calls.
   * CORS is not authentication: it only stops other sites' pages from reading responses.
   */
  readonly corsOrigins?: ReadonlyArray<string>;
}

/** `WEB_ORIGIN`: comma-separated origins, whitespace and a trailing slash ignored. */
export const parseOrigins = (raw: string | undefined): ReadonlyArray<string> =>
  (raw ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

/**
 * Builds the Coordinator HTTP app. Transport only: routes call core use cases
 * through the provider Layer chosen by the entry file (main.bun.ts / main.cloudflare.ts).
 * Routes: http/ (#13), MCP: mcp/ (#12), health sweep: health/ (#15).
 */
export const createApp = (
  options: ConstructorParameters<typeof Elysia>[0] = {},
  deps: AppDeps = {},
) => {
  const base = new Elysia(options);
  const withCors = deps.corsOrigins?.length
    ? base.use(
        cors({
          origin: [...deps.corsOrigins],
          methods: ["GET", "POST", "PATCH", "OPTIONS"],
          allowedHeaders: ["content-type"],
          // The API has no cookies or sessions to share across origins.
          credentials: false,
        }),
      )
    : base;
  const app = withCors.get("/health", () => ({ status: "ok", service: "coordinator" }));
  const withHttp = deps.http ? app.use(httpRoutes(deps.http)) : app;
  const withAuth = deps.auth ? withHttp.use(authRoutes(deps.auth)) : withHttp;
  const withConnect = deps.connect ? withAuth.use(connectRoutes(deps.connect)) : withAuth;
  return deps.mcp ? withConnect.use(mcpRoutes(deps.mcp)) : withConnect;
};
