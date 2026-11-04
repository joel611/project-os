import { Elysia } from "elysia";
import { httpRoutes, type HttpDeps } from "./http/routes.ts";

export interface AppDeps {
  /** HTTP ingress + admin routes (#13). Omitted: only `/health` is served. */
  readonly http?: HttpDeps;
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
  return deps.http ? app.use(httpRoutes(deps.http)) : app;
};
