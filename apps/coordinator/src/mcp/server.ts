import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { authenticateWorker } from "@project-os/core";
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

const bearer = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
};

/**
 * Elysia plugin: streamable HTTP MCP at `/mcp`, stateless (a fresh server + transport per request,
 * JSON responses). Shared workers call it without credentials (one trusted network). Personal
 * workers (registered with /register-worker) send their secret as a Bearer token; an unknown
 * token is refused outright.
 */
export const mcpRoutes = (runtime: McpRuntime) =>
  new Elysia({ name: "mcp" }).all(
    "/mcp",
    async ({ request }) => {
      const secret = bearer(request);
      const caller = secret ? await runtime.runPromise(authenticateWorker(secret)) : undefined;
      if (secret && !caller) {
        return new Response(JSON.stringify({ error: "unknown worker credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      // Omitting sessionIdGenerator selects stateless mode.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = makeMcpServer(runtime, makeTools(caller));
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
