import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { skillEntry, findSkill, parseSkillUri } from "@project-os/builtin-skills";
import { Effect, Schema, type ManagedRuntime } from "effect";
import { Elysia } from "elysia";
import { asWorker } from "../worker-access.ts";
import {
  listSkillEntries,
  makeSkillTools,
  readSkillFile,
  SKILLS_EXTENSION_ID,
  SkillsGetRequest,
  SkillsListRequest,
} from "./skills.ts";
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
  tools: readonly McpTool<McpServices>[],
  options: {
    /** EXPERIMENTAL: also serve the built-in skills as `skill://` resources (SEP-2640). */
    readonly experimentalSkills?: boolean;
  },
) => {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: "project-os-coordinator", version: "0.0.0" },
    {
      capabilities: {
        tools: {},
        ...(options.experimentalSkills && {
          resources: {},
          extensions: { [SKILLS_EXTENSION_ID]: {} },
        }),
      } as never,
    },
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

  if (options.experimentalSkills) {
    // Resources: every file of every built-in skill, read lazily by URI.
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: (await listSkillEntries()).flatMap((e) =>
        e.resources.map((r) => ({ uri: r.uri, name: r.uri.slice("skill://".length) })),
      ),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      const text = readSkillFile(request.params.uri);
      if (text === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
      }
      return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
    });
    server.setRequestHandler(SkillsListRequest as never, async () => ({
      skills: await listSkillEntries(),
    }));
    server.setRequestHandler(SkillsGetRequest as never, async (request: any) => {
      const parsed = parseSkillUri(request.params.uri);
      const skill = parsed && findSkill(parsed.name);
      if (!skill) throw new McpError(ErrorCode.InvalidParams, "Unknown skill");
      return await skillEntry(skill);
    });
  }

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
    /** EXPERIMENTAL: serve the built-in skills (`skill_*` tools and `skill://` resources). */
    readonly experimentalSkills?: boolean;
  } = {},
) =>
  new Elysia({ name: "mcp" }).all(
    "/mcp",
    asWorker(runtime, async ({ request }, caller) => {
      // Omitting sessionIdGenerator selects stateless mode.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const userToken = !(options.credentialProxy && caller.kind === "sandbox");
      const tools = makeTools(caller, { userToken });
      const server = makeMcpServer(
        runtime,
        options.experimentalSkills ? [...tools, ...makeSkillTools()] : tools,
        { ...(options.experimentalSkills && { experimentalSkills: true }) },
      );
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        // enableJsonResponse: a POST's response is complete once handleRequest resolves, so closing
        // here cuts nothing off.
        await server.close();
      }
    }),
    { parse: "none" },
  );
