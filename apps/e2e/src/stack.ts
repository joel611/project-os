import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Connections, makeConnections } from "@project-os/auth";
import { type IntentClassifier, UserConnections } from "@project-os/core";
import { ensureOrg, LocalLive, openLocalDb } from "@project-os/infra-local";
import { AgentRuntimeEcho } from "@project-os/testing";
import { Layer, ManagedRuntime } from "effect";
import { createReplyApp, type ReplyTarget } from "../../discord-adapter/src/reply.ts";
import { createApp } from "../../coordinator/src/app.ts";
import { makeAdminActions } from "../../coordinator/src/admin/actions.ts";
import type { McpRuntime } from "../../coordinator/src/mcp/server.ts";
import { type FakeOAuth, startFakeOAuth } from "./fake-oauth.ts";

// Every component wired as in main.bun.ts, each on its own localhost port.
// Real: SQLite, Coordinator HTTP + MCP, HTTP channel gateway, Discord adapter /reply.
// Faked: discord.js (a recording `post`), both AI ports (classifier, agent runtime), and,
// with `connections`, Google and GitHub (one fake OAuth server), so no test reaches a provider. `fetch` to any non-localhost host throws.

export interface Posted {
  readonly target: ReplyTarget;
  readonly content: string;
}

export interface CreatedThreadCall {
  readonly channelId: string;
  readonly messageId: string;
  readonly name: string;
}

export interface Stack {
  /** Coordinator base URL, e.g. `http://localhost:54321`. */
  readonly url: string;
  /** Messages the Discord adapter was told to post. */
  readonly posted: Posted[];
  /** Channels the Discord adapter was told to create (ids `discord-new-1`, …). */
  readonly createdChannels: string[];
  /** Threads the Discord adapter was told to open (ids `discord-thread-1`, …). */
  readonly createdThreads: CreatedThreadCall[];
  readonly json: (method: string, path: string, body?: unknown) => Promise<any>;
  /** The admin dialogue's Coordinator actions, run against this stack (real gateway + adapter). */
  readonly admin: ReturnType<typeof makeAdminActions>;
  /** Creates a project and links `channelId` as its default response channel. */
  readonly linkChannel: (channelId: string) => Promise<string>;
  /** The SQLite file every component shares. */
  readonly dbPath: string;
  /** The fake Google/GitHub OAuth server, when started with `connections`. */
  readonly oauth?: FakeOAuth;
  /** Connects an MCP client the way Claude Code does (SDK streamable HTTP). */
  readonly worker: () => Promise<Client>;
  readonly stop: () => Promise<void>;
}

export const ORG_ID = "o1";
/** Admin channel and the one admin allowed to run slash commands there. */
export const ADMIN_CHANNEL = "admin-chan";
export const ADMIN_USER = "admin-1";

const isLocal = (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
};

export const startStack = async (options: {
  readonly classifier: Layer.Layer<IntentClassifier>;
  readonly workerId: string;
  /** Account linking on Better Auth against a fake OAuth server (Google + GitHub). */
  readonly connections?: boolean;
}): Promise<Stack> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (!isLocal(input)) throw new Error(`integration stack blocked external fetch: ${input}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const dir = mkdtempSync(join(tmpdir(), "stack-"));
  const dbPath = join(dir, "project-os.sqlite");
  ensureOrg(dbPath, { id: ORG_ID, name: "Org" });

  const posted: Posted[] = [];
  const createdChannels: string[] = [];
  const createdThreads: CreatedThreadCall[] = [];
  const adapter = createReplyApp(
    async (target, content) => void posted.push({ target, content }),
    async (name) => {
      createdChannels.push(name);
      // Discord lowercases and hyphenates text channel names.
      return {
        channelId: `discord-new-${createdChannels.length}`,
        name: name.toLowerCase().replace(/\s+/g, "-"),
      };
    },
    async (input) => {
      createdThreads.push(input);
      return { threadId: `discord-thread-${createdThreads.length}` };
    },
  ).listen(0);

  // Better Auth needs the Coordinator's URL, known only once it listens: the Layer and the
  // routes delegate to `connections`, built right after `listen(0)`.
  const oauth = options.connections ? startFakeOAuth() : undefined;
  let connections: Connections | undefined;
  const lazy = (): Connections => connections!;
  const connectionsLayer = Layer.succeed(UserConnections, {
    connectUrl: (person, provider) => lazy().service.connectUrl(person, provider),
    list: (person) => lazy().service.list(person),
    disconnect: (person, provider) => lazy().service.disconnect(person, provider),
    accessToken: (person, provider) => lazy().service.accessToken(person, provider),
  });

  // Later layers win: the fakes replace LocalLive's AgentRuntime placeholder.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      LocalLive({ dbPath, adapterUrls: { discord: `http://localhost:${adapter.server!.port}` } }),
      options.classifier,
      AgentRuntimeEcho,
      ...(oauth ? [connectionsLayer] : []),
    ) as Layer.Layer<any, never>,
  ) as McpRuntime;

  const admin = makeAdminActions({
    run: (effect) => runtime.runPromise(effect as any),
    orgId: ORG_ID,
  });
  const coordinator = createApp(
    {},
    {
      http: {
        run: (effect) => runtime.runPromise(effect as any),
        inbound: { workerId: options.workerId, requireMention: true },
        commands: {
          adminChannelId: ADMIN_CHANNEL,
          adminUserIds: [ADMIN_USER],
          admin,
          connections: (effect) => runtime.runPromise(effect as any),
        },
      },
      mcp: runtime,
      ...(oauth && {
        connect: {
          startLink: (token: string) => lazy().startLink(token),
          handler: (request: Request) => lazy().handler(request),
        },
      }),
    },
  ).listen(0);
  const url = `http://localhost:${coordinator.server!.port}`;
  const authDb = oauth ? openLocalDb(dbPath) : undefined;
  if (oauth && authDb) {
    connections = makeConnections({
      db: authDb.db,
      baseURL: url,
      secret: "integration-secret-integration-secret",
      google: { clientId: "g-client", clientSecret: "g-secret", ...oauth.endpoints("google") },
      github: { clientId: "h-client", clientSecret: "h-secret", ...oauth.endpoints("github") },
    });
  }

  const clients: Client[] = [];

  const json = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return res.json() as Promise<any>;
  };

  return {
    url,
    posted,
    createdChannels,
    createdThreads,
    dbPath,
    ...(oauth && { oauth }),
    json,
    admin,
    linkChannel: async (channelId) => {
      const project = await json("POST", "/projects", { orgId: ORG_ID, name: "Acme" });
      await json("POST", `/projects/${project.id}/sources`, {
        type: "discord_channel",
        externalId: channelId,
        name: `#${channelId}`,
        alias: "chat",
        isDefaultResponse: true,
      });
      return project.id as string;
    },
    worker: async () => {
      const client = new Client({ name: "integration-worker", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      clients.push(client);
      return client;
    },
    stop: async () => {
      await Promise.all(clients.map((c) => c.close()));
      await coordinator.stop();
      await adapter.stop();
      oauth?.stop();
      authDb?.sqlite.close();
      await runtime.dispose();
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
