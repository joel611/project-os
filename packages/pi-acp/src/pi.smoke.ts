// Manual check against the real Pi SDK (not run by CI): `bun packages/pi-acp/src/pi.smoke.ts`.
// Starts a fake MCP server, opens a Pi session with it registered, and prints what Pi sent it:
// it should list initialize, tools/list, each with the Bearer header from the config below.
import { piSessionFactory } from "./pi.ts";
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as { method?: string; id?: unknown };
    seen.push(`${body.method} auth=${req.headers.get("authorization")}`);
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize")
      return reply({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      });
    if (body.method === "tools/list")
      return reply({
        tools: [
          {
            name: "ticket_claim",
            description: "claim",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    return new Response(null, { status: 202 });
  },
});
const run = await piSessionFactory()({
  cwd: process.cwd(),
  mcpServers: {
    "project-os": {
      url: `http://localhost:${server.port}/mcp`,
      headers: { Authorization: "Bearer s3cret" },
      exposure: "direct",
    },
  },
});
await new Promise((r) => setTimeout(r, 3000));
console.log(seen);
run.dispose();
server.stop(true);
process.exit(0);
