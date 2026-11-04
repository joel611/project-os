import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema, type ManagedRuntime } from "effect";
import { Elysia } from "elysia";
import { makeTools, type McpServices, type McpTool } from "./tools.ts";

export type McpRuntime = ManagedRuntime.ManagedRuntime<McpServices, never>;

const jsonSchema = (schema: Schema.Constraint) => {
  const { schema: root, definitions } = Schema.toJsonSchemaDocument(schema);
  return { ...root, $defs: definitions } as unknown as { type: "object" };
};

/**
 * Builds an MCP `Server` exposing `tools`, each run on `runtime`.
 * Typed failures are returned as `isError` tool results so the model can react to them.
 */
export const makeMcpServer = (
  runtime: McpRuntime,
  tools: readonly McpTool<McpServices>[] = makeTools(),
) => {
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
 * JSON responses). No auth: the Coordinator runs inside one trusted network.
 */
export const mcpRoutes = (runtime: McpRuntime) =>
  new Elysia({ name: "mcp" }).all(
    "/mcp",
    async ({ request }) => {
      // Omitting sessionIdGenerator selects stateless mode.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = makeMcpServer(runtime);
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        // Non-streaming (JSON) responses are complete once handleRequest resolves.
        await server.close();
      }
    },
    { parse: "none" },
  );
