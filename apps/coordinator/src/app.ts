import { Elysia } from "elysia";

/**
 * Builds the Coordinator HTTP app. Transport only: routes call core use cases
 * through the provider Layer chosen by the entry file (main.bun.ts / main.cloudflare.ts).
 * Routes: http/ (#13), MCP: mcp/ (#12), health sweep: health/ (#15).
 */
export const createApp = (options: ConstructorParameters<typeof Elysia>[0] = {}) =>
  new Elysia(options).get("/health", () => ({ status: "ok", service: "coordinator" }));
