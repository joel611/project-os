import { Elysia } from "elysia";
import { mcpRoutes, type McpRuntime } from "./mcp/server.ts";

/**
 * Builds the Coordinator HTTP app. Transport only: routes call core use cases
 * through the provider Layer chosen by the entry file (main.bun.ts / main.cloudflare.ts).
 * Routes: http/ (#13), MCP: mcp/ (#12), health sweep: health/ (#15).
 */
export const createApp = (
  options: ConstructorParameters<typeof Elysia>[0] = {},
  deps: { readonly mcp?: McpRuntime } = {},
) => {
  const app = new Elysia(options).get("/health", () => ({ status: "ok", service: "coordinator" }));
  // `/mcp` is mounted only when the entry file supplies a runtime.
  return deps.mcp ? app.use(mcpRoutes(deps.mcp)) : app;
};
