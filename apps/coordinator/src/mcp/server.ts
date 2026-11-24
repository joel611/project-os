import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { authenticateCaller } from "@project-os/core";
import { Effect, Schema, type ManagedRuntime } from "effect";
import { Elysia } from "elysia";
import { bearerToken, sameSecret } from "../access.ts";
import { makeAdminTools, type AdminToolDeps } from "./admin-tools.ts";
import { makeTools, type McpServices, type McpTool } from "./tools.ts";

export type McpRuntime = ManagedRuntime.ManagedRuntime<McpServices, never>;

const jsonSchema = (schema: Schema.Constraint) => {
  const { schema: root, definitions } = Schema.toJsonSchemaDocument(schema);
  // An empty struct ("no arguments") comes out as `{ not: { type: "null" } }`; MCP wants an object.
  const object = "type" in root ? root : { type: "object", additionalProperties: false };
  return { ...object, $defs: definitions } as unknown as { type: "object" };
};

/**
 * Builds an MCP `Server` exposing `tools`, each run on `runtime`.
 * Typed failures are returned as `isError` tool results so the model can react to them.
 */
export const makeMcpServer = (runtime: McpRuntime, tools: readonly McpTool<McpServices>[]) => {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: "project-os-coordinator", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      outputSchema: jsonSchema(t.outputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `UnknownTool: ${request.params.name}` }],
      };
    }
    const outcome = await runtime.runPromise(
      tool.call(request.params.arguments ?? {}).pipe(
        Effect.match({
          onFailure: (failure) => ({ ok: false as const, value: failure }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    const text = JSON.stringify(outcome.value);
    if (!outcome.ok) return { isError: true, content: [{ type: "text" as const, text }] };
    return {
      structuredContent: outcome.value as Record<string, unknown>,
      content: [{ type: "text" as const, text }],
    };
  });

  return server;
};

/**
 * Elysia plugin: streamable HTTP MCP at `/mcp`, stateless (a fresh server + transport per request,
 * JSON responses). Every caller sends a Bearer token: a registered device its secret, a sandbox
 * session the token it was launched with. No token, or an unknown one, is refused outright.
 */
export const mcpRoutes = (
  runtime: McpRuntime,
  options: {
    /** The credential proxy is on: sandbox sessions get no `user_token`. */
    readonly credentialProxy?: boolean;
  } = {},
) =>
  new Elysia({ name: "mcp" }).all(
    "/mcp",
    async ({ request }) => {
      const token = bearerToken(request);
      const caller = token ? await runtime.runPromise(authenticateCaller(token)) : undefined;
      if (!caller) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Omitting sessionIdGenerator selects stateless mode.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const userToken = !(options.credentialProxy && caller.kind === "sandbox");
      const server = makeMcpServer(runtime, makeTools(caller, { userToken }));
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        // enableJsonResponse: a POST's response is complete once handleRequest resolves, so closing
        // here cuts nothing off.
        await server.close();
      }
    },
    { parse: "none" },
  );

/**
 * Elysia plugin: the admin MCP at `/mcp/admin`, read-only views of the dashboard's data for
 * tracing and debugging. One static Bearer `token` (ADMIN_MCP_TOKEN), compared in constant time;
 * Worker, dashboard and service credentials are refused. Same stateless transport as `/mcp`.
 */
export const adminMcpRoutes = (
  runtime: McpRuntime,
  options: AdminToolDeps & { readonly token: string },
) =>
  new Elysia({ name: "mcp-admin" }).all(
    "/mcp/admin",
    async ({ request }) => {
      const presented = bearerToken(request);
      if (!presented || !(await sameSecret(presented, options.token))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = makeMcpServer(runtime, makeAdminTools(options));
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    },
    { parse: "none" },
  );
