import { Elysia } from "elysia";
import { type ConnectDeps, connectRoutes } from "./connect/routes.ts";
import { httpRoutes, type HttpDeps } from "./http/routes.ts";
import { mcpRoutes, type McpRuntime } from "./mcp/server.ts";

export interface AppDeps {
  /** HTTP ingress + admin routes (#13). Omitted: no ingress routes. */
  readonly http?: HttpDeps;
  /** MCP server (#12). Omitted: `/mcp` is not mounted. */
  readonly mcp?: McpRuntime;
  /** Account linking (`/connect/*`, `/api/auth/*`). Omitted: not mounted. */
  readonly connect?: ConnectDeps;
}

/**
 * Builds the Coordinator HTTP app. Transport only: routes call core use cases
 * through the provider Layer chosen by the entry file (main.bun.ts / main.cloudflare.ts).
 * Routes: http/ (#13), MCP: mcp/ (#12), health sweep: health/ (#15).
 */
export const createApp = (
  options: ConstructorParameters<typeof Elysia>[0] = {},
  deps: AppDeps = {},
) => {
  const app = new Elysia(options).get("/health", () => ({ status: "ok", service: "coordinator" }));
  const withHttp = deps.http ? app.use(httpRoutes(deps.http)) : app;
  const withConnect = deps.connect ? withHttp.use(connectRoutes(deps.connect)) : withHttp;
  return deps.mcp ? withConnect.use(mcpRoutes(deps.mcp)) : withConnect;
};
