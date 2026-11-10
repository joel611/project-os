// Drives the running verification stack the way production actors do.
//   bun drive.ts say "<message>" [--channel verify-chan] [--user u1] [--name Ada] [--attach <file>]
//       A Discord user speaks: real normalizeMessage -> POST /inbound (what the Discord adapter does).
//       --attach sends a file with the message, served to the Coordinator by serve.ts's fake CDN.
//   bun drive.ts work "<result body>" [--memory "<fact>"]
//       A Worker plays session-start.md over real MCP: list assigned -> claim -> read memory
//       -> (optional memory write) -> append result -> complete. Prints the ticket id.
// Env: COORD_PORT=18080, DATA_DIR (holds worker.json, the shared worker serve.ts registered).
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";

const url = `http://localhost:${process.env.COORD_PORT ?? 18080}`;
const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("DATA_DIR is required (run.sh sets it)");
const { workerId, secret } = JSON.parse(readFileSync(join(dataDir, "worker.json"), "utf8")) as {
  workerId: string;
  secret: string;
};
const transport = () =>
  new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
  });
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string", default: "verify-chan" },
    user: { type: "string", default: "u1" },
    name: { type: "string", default: "Ada" },
    memory: { type: "string" },
    attach: { type: "string" },
  },
});
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};
/** Puts `path` on serve.ts's fake CDN and describes it as Discord would on the message. */
const attachmentFor = (path: string) => {
  const name = basename(path);
  copyFileSync(path, join(dataDir, "cdn", name));
  return {
    id: `att-${Date.now()}`,
    name,
    contentType: TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
    size: statSync(path).size,
    url: `http://localhost:${process.env.ADAPTER_PORT ?? 18081}/cdn/${name}`,
  };
};
const [cmd, text] = positionals;
if (!text && cmd !== "heartbeat") throw new Error('usage: drive.ts say|work "<text>" | heartbeat');

if (cmd === "heartbeat") {
  // What the Watcher does every poll: marks the worker online in GET /workers.
  const mcp = new Client({ name: "verify-worker", version: "0" });
  await mcp.connect(transport());
  const res = (await mcp.callTool({
    name: "worker_heartbeat",
    arguments: { workerId, workerType: "local" },
  })) as { isError?: boolean; structuredContent?: any };
  if (res.isError) throw new Error(`worker_heartbeat failed: ${JSON.stringify(res)}`);
  await mcp.close();
  console.log(`heartbeat ${workerId} lastSeenAt=${res.structuredContent.lastSeenAt}`);
} else if (cmd === "say") {
  const attachments = values.attach ? [attachmentFor(values.attach)] : undefined;
  const inbound = fakeInbound(
    { channelId: values.channel!, userId: values.user!, name: values.name! },
    text,
    attachments ? { attachments } : {},
  );
  if (!inbound) throw new Error("empty message ignored");
  const token = readFileSync(join(dataDir, "service.token"), "utf8");
  await forwardInbound({ url, token }, inbound, fetch);
  console.log(`said: ${text}`);
} else if (cmd === "work") {
  const mcp = new Client({ name: "verify-worker", version: "0" });
  await mcp.connect(transport());
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: any;
    };
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res)}`);
    return res.structuredContent;
  };
  const { tickets } = await tool("ticket_list_assigned", { workerId });
  if (!tickets.length) throw new Error("no assigned ticket (did `say` run?)");
  const ticketId = tickets[0].id as string;
  await tool("ticket_claim", { ticketId, workerId });
  const { ticket } = await tool("ticket_get", { ticketId });
  await tool("project_memory_read", { projectId: ticket.projectId });
  if (values.memory)
    await tool("project_memory_write", {
      projectId: ticket.projectId,
      ticketId,
      type: "worker_note",
      title: values.memory.slice(0, 40),
      content: values.memory,
    });
  await tool("ticket_append_event", {
    ticketId,
    type: "result",
    actor: "worker",
    actorId: workerId,
    body: text,
  });
  await tool("ticket_update_status", { ticketId, status: "completed" });
  await mcp.close();
  console.log(`completed ticket ${ticketId}`);
} else throw new Error(`unknown command ${cmd}`);
