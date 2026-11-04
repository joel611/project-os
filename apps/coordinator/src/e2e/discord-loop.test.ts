import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { schema } from "@project-os/db-sqlite";
import { LocalLive, openLocalDb } from "@project-os/infra-local";
import { AgentRuntimeEcho, classifierReturning } from "@project-os/testing";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound, type FakeSpeaker } from "../../../discord-adapter/src/fake.ts";
import { forwardInbound } from "../../../discord-adapter/src/forward.ts";
import { createReplyApp } from "../../../discord-adapter/src/reply.ts";
import { createApp } from "../app.ts";
import type { McpRuntime } from "../mcp/server.ts";

// Discord -> /inbound -> ticket -> MCP worker -> completion -> /reply, with no Discord.
// Real: SQLite, HTTP routes, MCP server, HTTP channel gateway, adapter reply endpoint.
// Faked: the discord.js client (replaced by fakeInbound / a recording `post`), the
// classifier, and the agent runtime (echoes its prompt).

const T0 = "2026-11-04T00:00:00.000Z";
const WORKER = "w1";
const CHANNEL = "chan-1";
const speaker: FakeSpeaker = { channelId: CHANNEL, userId: "u1", name: "Ada" };

interface Posted {
  target: { channelId: string; threadId?: string };
  content: string;
}

let dir: string;
let adapter: { stop: () => unknown } | undefined;
let runtime: McpRuntime | undefined;
let mcp: Client | undefined;
let app: ReturnType<typeof createApp>;
let posted: Posted[];

const boot = async (classifier: ReturnType<typeof classifierReturning>) => {
  dir = mkdtempSync(join(tmpdir(), "e2e-"));
  const dbPath = join(dir, "test.sqlite");
  const { sqlite, db } = openLocalDb(dbPath);
  db.insert(schema.orgs).values({ id: "o1", name: "Org", createdAt: T0 }).run();
  sqlite.close();

  posted = [];
  const adapterApp = createReplyApp(
    async (target, content) => void posted.push({ target, content }),
  ).listen(0);
  adapter = adapterApp;

  const rt = ManagedRuntime.make(
    Layer.mergeAll(
      LocalLive({
        dbPath,
        adapterUrls: { discord: `http://localhost:${adapterApp.server!.port}` },
      }),
      classifier,
      AgentRuntimeEcho,
    ) as Layer.Layer<any, never>,
  ) as McpRuntime;
  runtime = rt;

  app = createApp(
    {},
    {
      http: { run: (effect) => rt.runPromise(effect as any), inbound: { workerId: WORKER } },
      mcp: rt,
    },
  );
  const client = new Client({ name: "e2e-worker", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => app.handle(new Request(url.toString(), init)),
    }),
  );
  mcp = client;
};

afterEach(async () => {
  await mcp?.close();
  await runtime?.dispose();
  await adapter?.stop();
  mcp = runtime = adapter = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const json = async (method: string, path: string, body?: unknown) => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
  return (await res.json()) as any;
};

const linkChannel = async () => {
  const project = await json("POST", "/projects", { orgId: "o1", name: "Acme" });
  await json("POST", `/projects/${project.id}/sources`, {
    type: "discord_channel",
    externalId: CHANNEL,
    name: "#acme",
    isDefaultResponse: true,
  });
  return project.id as string;
};

const sayInDiscord = async (who: FakeSpeaker, content: string, id?: string) => {
  const inbound = fakeInbound(who, content, id ? { id } : {});
  if (!inbound) return;
  await forwardInbound("http://localhost", inbound, (req) => app.handle(req));
};

const tool = async (name: string, args: Record<string, unknown>) =>
  ((await mcp!.callTool({ name, arguments: args })) as { structuredContent?: any })
    .structuredContent;

describe("discord loop, no Discord", () => {
  describe("with a confident new_request classifier", () => {
    beforeEach(() => boot(classifierReturning("new_request")));

    it("turns a message into a ticket, and completing it replies in the channel", async () => {
      const projectId = await linkChannel();
      await sayInDiscord(speaker, "please add dark mode");

      const tickets = await json("GET", `/projects/${projectId}/tickets`);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({ title: "please add dark mode", workerId: WORKER });
      expect(posted).toEqual([]);

      const assigned = await tool("ticket_list_assigned", { workerId: WORKER });
      const ticketId = assigned.tickets[0].id as string;
      expect(ticketId).toBe(tickets[0].id);
      await tool("ticket_claim", { ticketId, workerId: WORKER });
      await tool("ticket_append_event", {
        ticketId,
        type: "comment",
        actor: "worker",
        actorId: WORKER,
        body: "dark mode shipped",
      });
      await tool("ticket_update_status", { ticketId, status: "completed" });

      expect(posted).toHaveLength(1);
      expect(posted[0]!.target).toEqual({ channelId: CHANNEL });
      expect(posted[0]!.content).toContain("please add dark mode");
      expect(posted[0]!.content).toContain("dark mode shipped");
    });

    it("ignores a duplicate delivery of the same Discord message", async () => {
      const projectId = await linkChannel();
      await sayInDiscord(speaker, "build it", "dup-1");
      await sayInDiscord(speaker, "build it", "dup-1");
      expect(await json("GET", `/projects/${projectId}/tickets`)).toHaveLength(1);
    });

    it("creates nothing for an unlinked channel", async () => {
      const projectId = await linkChannel();
      await sayInDiscord({ ...speaker, channelId: "other-chan" }, "hello?");
      expect(await json("GET", `/projects/${projectId}/tickets`)).toEqual([]);
      expect(posted).toEqual([]);
    });
  });

  describe("with a low-confidence classifier", () => {
    beforeEach(() => boot(classifierReturning("new_request", 0.1)));

    it("asks a clarifying question in the same thread", async () => {
      const projectId = await linkChannel();
      await sayInDiscord({ ...speaker, threadId: "th-1" }, "uhh");

      expect(posted).toHaveLength(1);
      expect(posted[0]!.target).toEqual({ channelId: CHANNEL, threadId: "th-1" });
      expect(posted[0]!.content).toContain("didn't catch that");
      expect(await json("GET", `/projects/${projectId}/tickets`)).toEqual([]);
    });
  });
});
