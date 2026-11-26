import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Auth,
  type AuthApi,
  type Connections,
  GOOGLE_SCOPES,
  type SharedAccounts,
} from "@project-os/auth";
import { GMAIL_READ_SCOPE } from "@project-os/contracts";
import {
  DEFAULT_EMAIL_DIGEST,
  type ChannelDigestConfig,
  DEFAULT_CHANNEL_DIGEST,
  type DigestRun,
  digestChannels,
  type IntentClassifier,
  issueSandboxToken,
  recordSandboxRun,
  type SandboxRun,
  type SkillSource,
  UserConnections,
  type WorkerLauncher,
} from "@project-os/core";
import { DrizzleBun, ensureOrg, LocalLive, makeGithubSkillSource } from "@project-os/infra-local";
import {
  AgentRuntimeEcho,
  type ChannelDigestCall,
  makeChannelDigesterRecording,
  makeEmailClassifierFake,
  makeSidekickRecording,
  type SidekickCall,
} from "@project-os/testing";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { emailDigestAndLog, gmailEmailSource } from "../../coordinator/src/email/index.ts";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand } from "../../../packages/channel-discord/src/fake.ts";
import type { CoordinatorTarget } from "../../../packages/channel-discord/src/forward.ts";
import type { ActionRow } from "../../../packages/channel-discord/src/prompts.ts";
import { createReplyApp, type ReplyTarget } from "../../../packages/channel-discord/src/reply.ts";
import { registerDevice } from "../../watcher/src/register.ts";
import { makeAccess } from "../../coordinator/src/access.ts";
import { type AppDeps, createApp } from "../../coordinator/src/app.ts";
import { coordinatorConfig } from "../../coordinator/src/config.ts";
import { makeAdminActions } from "../../coordinator/src/admin/actions.ts";
import type { McpRuntime } from "../../coordinator/src/mcp/server.ts";
import { type FakeOAuth, startFakeOAuth } from "./fake-oauth.ts";

// Every component wired as in main.bun.ts (config from the same `coordinatorConfig`), each on its own localhost port.
// Real: SQLite, Coordinator HTTP + MCP, HTTP channel gateway, Discord adapter /reply.
// Faked: discord.js (a recording `post`), both AI ports (classifier, agent runtime), and,
// with `connections`, Google and GitHub (one fake OAuth server), so no test reaches a provider. `fetch` to any non-localhost host throws.

/** A file on a fake Discord message, as the adapter reports it. */
/** A message in the fake Gmail mailbox. */
export interface FakeGmailMessage {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  /** Default `INBOX`. */
  readonly labels?: ReadonlyArray<string>;
}

export interface MessageFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly url: string;
}

export interface Posted {
  readonly target: ReplyTarget;
  readonly content: string;
  readonly files?: ReadonlyArray<{ readonly filename: string; readonly data: Uint8Array }>;
}

export interface CreatedThreadCall {
  readonly channelId: string;
  readonly messageId?: string;
  readonly name: string;
}

export interface ReactionCall {
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly emoji: string;
}

export interface PostedPrompt {
  readonly target: ReplyTarget;
  readonly content: string;
  /** The buttons or select menu, as sent to Discord. */
  readonly components: ActionRow[];
  /** Message id handed back (`discord-prompt-1`, …). */
  readonly messageId: string;
}

export interface Stack {
  /** Coordinator base URL, e.g. `http://localhost:54321`. */
  readonly url: string;
  /** The Coordinator as a Channel Adapter calls it: URL plus the service token. */
  readonly coordinator: CoordinatorTarget;
  /** The seeded operator's dashboard session token, signed in at /api/auth/sign-in/email. */
  readonly operatorToken: string;
  /** Messages the Discord adapter was told to post. */
  readonly posted: Posted[];
  /** Channels the Discord adapter was told to create (ids `discord-new-1`, …). */
  readonly createdChannels: string[];
  /** Threads the Discord adapter was told to open (ids `discord-thread-1`, …). */
  readonly createdThreads: CreatedThreadCall[];
  /** Reactions the Discord adapter was told to add. */
  readonly reactions: ReactionCall[];
  /** Prompts (messages with buttons) the Discord adapter was told to post. */
  readonly prompts: PostedPrompt[];
  /**
   * Files on the messages fake Discord still holds, by `<channelId>/<messageId>`. Re-reading a
   * message returns its entry (the fresh links); a message with no entry is "deleted".
   */
  readonly messageFiles: Map<string, MessageFile[]>;
  /**
   * Serves `bytes` from a fake CDN on localhost and returns the URL, for an attachment the
   * Coordinator should copy (the stack allows downloads from `localhost` only).
   */
  readonly hostFile: (name: string, bytes: Uint8Array | string, type?: string) => string;
  /** Calls the dashboard API as the signed-in operator; resolves to the JSON body. */
  readonly json: (method: string, path: string, body?: unknown) => Promise<any>;
  /** The admin dialogue's Coordinator actions, run against this stack (real gateway + adapter). */
  readonly admin: ReturnType<typeof makeAdminActions>;
  /** Creates a project and links `channelId` as its default response channel. */
  readonly linkChannel: (channelId: string) => Promise<string>;
  /** Turns the faked Sidekick took, with the requester's GitHub token as a tool would see it. */
  readonly sidekickCalls: SidekickCall[];
  /** Calls the Channel Digest made to its (faked) model. */
  readonly digestCalls: ChannelDigestCall[];
  /**
   * One Channel Digest run, as the Cron tick does it. Default settings, except nothing waits
   * for a quiet channel unless `config` says so.
   */
  readonly runDigest: (config?: Partial<ChannelDigestConfig>) => Promise<ReadonlyArray<DigestRun>>;
  /**
   * The Email Digest, when started with `email`: a fake Gmail API on localhost that the real
   * Gmail reader talks to, and the run the Cron tick makes.
   */
  readonly email?: {
    /** Mail in the fake mailbox; the next sync reads what arrived since the cursor. */
    readonly deliver: (...messages: FakeGmailMessage[]) => void;
    readonly gmailCalls: string[];
    readonly classifyCalls: Array<{ from: string; subject: string; body: string }>;
    readonly runDigest: () => Promise<void>;
  };
  /** The SQLite file every component shares. */
  readonly dbPath: string;
  /** The fake Google/GitHub OAuth server, when started with `connections`. */
  readonly oauth?: FakeOAuth;
  /** The stand-in dashboard's origin Google sign-in returns to, when started with `connections`. */
  readonly webUrl?: string;
  /** The Coordinator's Better Auth, for a test to set up a session the UI can't make. */
  readonly auth: AuthApi;
  /** Sets the dashboard role of the user with this email, as an admin would on the Members page. */
  readonly setRole: (email: string, role: "admin" | "member") => Promise<void>;
  /**
   * Connects an MCP client the way Claude Code does (SDK streamable HTTP). `token`: a registered
   * device's secret, as the Watcher puts in Claude Code's MCP config, or a sandbox session's.
   */
  readonly worker: (token: string) => Promise<Client>;
  /** Mints the MCP token a sandbox session launched as `workerId` would get. */
  readonly sandboxToken: (workerId: string) => Promise<string>;
  /** Keeps a finished sandbox session's output as a run, as the Coordinator's launcher hook does. */
  readonly recordSandboxRun: (session: SandboxRun) => Promise<void>;
  /**
   * Adds a shared worker the way an admin does: `/register-worker shared:True` in the admin
   * channel, the Watcher trading the code at POST /workers/register, then a heartbeat so it
   * reads as online. Returns its id, secret, and an MCP client that sends the secret.
   */
  readonly registerSharedWorker: (
    name?: string,
  ) => Promise<{ readonly workerId: string; readonly secret: string; readonly mcp: Client }>;
  readonly stop: () => Promise<void>;
}

export const ORG_ID = "o1";
/** Admin channel and the one admin allowed to run slash commands there. */
export const ADMIN_CHANNEL = "admin-chan";
export const ADMIN_USER = "admin-1";
/** The seeded dashboard operator (ADMIN_EMAIL / ADMIN_PASSWORD). */
export const OPERATOR = { email: "operator@project-os.test", password: "operator-password" };
/** COORDINATOR_SERVICE_TOKEN: what the Discord adapter calls /inbound and friends with. */
export const SERVICE_TOKEN = "integration-service-token";

const isLocal = (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
};

export const startStack = async (options: {
  readonly classifier: Layer.Layer<IntentClassifier>;
  /**
   * Google and GitHub against a fake OAuth server: account linking, and Google sign-in for a
   * stand-in dashboard (`webUrl`).
   */
  readonly connections?: boolean;
  /** ADMIN_EMAILS: who besides the seeded operator may use the dashboard. */
  readonly allowedEmails?: ReadonlyArray<string>;
  /** GOOGLE_ALLOWED_DOMAINS: the only Workspace domains Google sign-in takes. */
  readonly allowedDomains?: ReadonlyArray<string>;
  readonly workerLauncher?: typeof WorkerLauncher.Service;
  /** Where skills come from. Default: GitHub, which this stack's fetch guard refuses. */
  readonly skillSource?: typeof SkillSource.Service;
  readonly githubSkills?: { readonly fetch: typeof fetch; readonly token?: string };
  /**
   * Tickets one shared device may hold. Default here 100, so suites that open several
   * tickets on one shared worker don't queue them; production defaults to 1.
   */
  readonly sharedWorkerMaxTickets?: number;
  /** Largest file copied into storage. Default: the production limit. */
  readonly maxAttachmentBytes?: number;
  /** Make every Channel Digest model call fail with this message. */
  readonly failDigest?: string;
  /**
   * Turns the Email Digest on (`EMAIL_DIGEST`): Google linking asks for Gmail read access, mail
   * is read from a fake Gmail API on localhost, and a fake classifier matches project names.
   * Needs `connections`.
   */
  readonly email?: { readonly confidence?: number };
  /** Mounts the credential proxy (`SANDBOX_CREDENTIAL_PROXY`), forwarding to these origins. */
  readonly credentialProxy?: NonNullable<AppDeps["credentialProxy"]>;
}): Promise<Stack> => {
  if (options.skillSource && options.githubSkills) {
    throw new Error("skillSource and githubSkills are mutually exclusive");
  }
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
  const reactions: ReactionCall[] = [];
  const prompts: PostedPrompt[] = [];
  const messageFiles = new Map<string, MessageFile[]>();
  const cdnFiles = new Map<string, { bytes: Uint8Array | string; type: string }>();
  const cdn = Bun.serve({
    port: 0,
    fetch: (req) => {
      const file = cdnFiles.get(new URL(req.url).pathname);
      return file
        ? new Response(file.bytes, { headers: { "content-type": file.type } })
        : new Response("gone", { status: 404 });
    },
  });
  const adapter = createReplyApp(
    async (target, content, files) =>
      void posted.push({ target, content, ...(files && { files }) }),
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
    async (input) => void reactions.push(input),
    async (target, message) => {
      const messageId = `discord-prompt-${prompts.length + 1}`;
      prompts.push({ target, ...message, messageId });
      return { messageId };
    },
    async ({ channelId, messageId }) => {
      const files = messageFiles.get(`${channelId}/${messageId}`);
      if (!files) throw new Error("Unknown Message");
      return files;
    },
  ).listen(0);

  // Better Auth needs the Coordinator's URL, known only once it listens: the Layer and the
  // routes delegate to `auth`, built right after `listen(0)`.
  const oauth = options.connections ? startFakeOAuth() : undefined;
  // Stands where the dashboard is served, so Google sign-in has somewhere to return to.
  const web = oauth ? Bun.serve({ port: 0, fetch: () => new Response("dashboard") }) : undefined;
  let auth: AuthApi | undefined;
  let authRuntime: ManagedRuntime.ManagedRuntime<Auth, never> | undefined;
  const lazy = (): Connections => auth!.connections!;
  const connectionsLayer = Layer.succeed(UserConnections, {
    connectUrl: (person, provider) => lazy().service.connectUrl(person, provider),
    list: (person) => lazy().service.list(person),
    disconnect: (person, provider) => lazy().service.disconnect(person, provider),
    accessToken: (person, provider) => lazy().service.accessToken(person, provider),
  });

  const gmailMessages: FakeGmailMessage[] = [];
  const gmailCalls: string[] = [];
  const gmail = options.email
    ? Bun.serve({
        port: 0,
        fetch: (req) => {
          const { pathname, search } = new URL(req.url);
          gmailCalls.push(`${pathname}${search} ${req.headers.get("authorization")}`);
          const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_");
          if (pathname.endsWith("/profile")) {
            return Response.json({ historyId: String(gmailMessages.length) });
          }
          if (pathname.endsWith("/history")) {
            const params = new URL(req.url).searchParams;
            const start = Number(params.get("startHistoryId"));
            const labelId = params.get("labelId");
            return Response.json({
              history: gmailMessages
                .slice(start)
                .map((m, i) => ({ m, id: String(start + i + 1) }))
                // Gmail only reports changes to mail that has the label asked for.
                .filter(({ m }) => (m.labels ?? ["INBOX"]).includes(labelId!))
                .map(({ m, id }) => ({ id, messagesAdded: [{ message: { id: m.id } }] })),
              historyId: String(gmailMessages.length),
            });
          }
          if (pathname.endsWith("/labels")) {
            return Response.json({
              labels: [
                { id: "INBOX", name: "INBOX", type: "system" },
                { id: "Label_1", name: "Clients", type: "user" },
              ],
            });
          }
          const m = gmailMessages.find((x) => pathname.endsWith(`/messages/${x.id}`))!;
          return Response.json({
            id: m.id,
            threadId: `t-${m.id}`,
            labelIds: m.labels ?? ["INBOX"],
            internalDate: String(Date.now()),
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: m.from },
                { name: "Subject", value: m.subject },
              ],
              body: { data: b64(m.body) },
            },
          });
        },
      })
    : undefined;
  if (options.email) oauth!.scope = `openid email profile drive.readonly ${GMAIL_READ_SCOPE}`;
  const emailClassifier = makeEmailClassifierFake({
    ...(options.email?.confidence === undefined ? {} : { confidence: options.email.confidence }),
  });
  const sidekick = makeSidekickRecording({ probe: "github" });
  const digester = makeChannelDigesterRecording(
    options.failDigest === undefined ? {} : { fail: options.failDigest },
  );

  // Later layers win: the fakes replace LocalLive's AgentRuntime and Sidekick placeholders.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      LocalLive({
        dbPath,
        adapterUrls: { discord: `http://localhost:${adapter.server!.port}` },
        ...(options.workerLauncher && { workerLauncher: options.workerLauncher }),
        ...(options.skillSource && { skillSource: options.skillSource }),
        ...(options.githubSkills && {
          skillSource: makeGithubSkillSource({
            ...options.githubSkills,
            getToken: async () => (await auth?.sharedAccounts?.accessToken("github"))?.accessToken,
          }),
        }),
        assets: {
          dir: join(dir, "assets"),
          // Known once the Coordinator listens; read only when a link is made.
          get publicUrl(): string {
            return url;
          },
          secret: "asset-secret-asset-secret-asset-secret",
        },
      }),
      options.classifier,
      AgentRuntimeEcho,
      sidekick.layer,
      digester.layer,
      ...(oauth ? [connectionsLayer] : []),
    ).pipe((base) =>
      gmail
        ? Layer.mergeAll(
            base,
            emailClassifier.layer,
            // The real Gmail reader, pointed at the fake API: the only change is the origin.
            gmailEmailSource({
              fetch: (input, init) =>
                fetch(
                  input.replace("https://gmail.googleapis.com", `http://localhost:${gmail.port}`),
                  init,
                ),
            }).pipe(Layer.provide(connectionsLayer)),
          )
        : base,
    ) as Layer.Layer<any, never>,
  ) as McpRuntime;

  const admin = makeAdminActions({
    run: (effect) => runtime.runPromise(effect as any),
    orgId: ORG_ID,
  });
  const coordinator = createApp(
    {},
    {
      access: makeAccess({
        serviceToken: SERVICE_TOKEN,
        auth: {
          sessionUser: (token) => auth!.sessionUser(token),
          isAllowed: (email) => auth!.isAllowed(email),
          memberPerson: (user) => auth!.memberPerson(user),
          linkedPerson: (userId) => auth!.linkedPerson(userId),
        },
      }),
      ...coordinatorConfig({
        env: {
          ADMIN_CHANNEL_ID: ADMIN_CHANNEL,
          ADMIN_USER_IDS: ADMIN_USER,
          ...(web && { WEB_ORIGIN: web.url.origin }),
        },
        run: (effect) => runtime.runPromise(effect as any),
        // Known once the Coordinator listens; read only when a command runs.
        publicUrl: () => url,
        admin,
        inbound: {
          attachments: {
            hosts: ["localhost"],
            ...(options.maxAttachmentBytes && { maxBytes: options.maxAttachmentBytes }),
          },
          sharedWorkerMaxTickets: options.sharedWorkerMaxTickets ?? 100,
          // As when the entry file found a digest model.
          channelDigest: true,
        },
      }),
      mcp: runtime,
      ...(options.email && { emailDigest: true }),
      ...(options.credentialProxy && { credentialProxy: options.credentialProxy }),
      auth: {
        handler: (request: Request) => auth!.handler(request),
        ...(oauth && {
          googleSignIn: {
            get domains() {
              return auth!.googleSignIn!.domains;
            },
            start: () => auth!.googleSignIn!.start(),
            handoff: (request: Request) => auth!.googleSignIn!.handoff(request),
          },
        }),
      },
      members: () => auth!.members(),
      setRole: (userId, role) => auth!.setRole(userId, role),
      // The auth instance is built after the app, so each call looks it up when it is made.
      ...(oauth && {
        sharedAccounts: new Proxy({} as SharedAccounts, {
          get: (_, name) => (auth!.sharedAccounts as Record<string | symbol, unknown>)[name],
        }),
      }),
      ...(oauth && {
        connect: { startLink: (token: string) => lazy().startLink(token) },
      }),
    },
  ).listen(0);
  const url: string = `http://localhost:${coordinator.server!.port}`;
  authRuntime = ManagedRuntime.make(
    Auth.layer({
      baseURL: url,
      secret: "integration-secret-integration-secret",
      admin: OPERATOR,
      ...(options.allowedEmails && { allowedEmails: options.allowedEmails }),
      ...(options.allowedDomains && { allowedDomains: options.allowedDomains }),
      ...(web && { webOrigins: [web.url.origin] }),
      ...(oauth && {
        google: {
          clientId: "g-client",
          clientSecret: "g-secret",
          ...oauth.endpoints("google"),
          ...(options.email && { scopes: [...GOOGLE_SCOPES, GMAIL_READ_SCOPE] }),
        },
        github: { clientId: "h-client", clientSecret: "h-secret", ...oauth.endpoints("github") },
        clickup: { clientId: "c-client", clientSecret: "c-secret", ...oauth.endpoints("clickup") },
      }),
    }).pipe(Layer.provide(DrizzleBun(dbPath))),
  );
  auth = authRuntime.runSync(Auth);
  await auth.ready();
  const signIn = await fetch(`${url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OPERATOR),
  });
  const operatorToken = signIn.headers.get("set-auth-token")!;
  const target: CoordinatorTarget = { url, token: SERVICE_TOKEN };

  const clients: Client[] = [];
  const worker = async (token: string) => {
    const client = new Client({ name: "integration-worker", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  };

  const json = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return res.json() as Promise<any>;
  };

  return {
    url,
    coordinator: target,
    operatorToken,
    setRole: async (email, role) => {
      const ctx = await auth!.auth.$context;
      const user = await ctx.internalAdapter.findUserByEmail(email.toLowerCase());
      await ctx.internalAdapter.updateUser(user!.user.id, { role });
    },
    posted,
    createdChannels,
    createdThreads,
    reactions,
    prompts,
    messageFiles,
    hostFile: (name, bytes, type = "application/octet-stream") => {
      const path = `/files/${name}`;
      cdnFiles.set(path, { bytes, type });
      return `http://localhost:${cdn.port}${path}`;
    },
    sidekickCalls: sidekick.calls,
    digestCalls: digester.calls,
    runDigest: (config) =>
      runtime.runPromise(
        digestChannels({ ...DEFAULT_CHANNEL_DIGEST, quietMs: 0, ...config }) as Effect.Effect<
          ReadonlyArray<DigestRun>,
          never,
          any
        >,
      ),
    ...(gmail && {
      email: {
        deliver: (...messages: FakeGmailMessage[]) => void gmailMessages.push(...messages),
        gmailCalls,
        classifyCalls: emailClassifier.calls,
        runDigest: () =>
          runtime.runPromise(
            emailDigestAndLog(DEFAULT_EMAIL_DIGEST) as Effect.Effect<void, never, any>,
          ),
      },
    }),
    dbPath,
    ...(oauth && { oauth }),
    ...(web && { webUrl: web.url.origin }),
    auth,
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
    worker,
    recordSandboxRun: (session) => runtime.runPromise(recordSandboxRun(session) as any),
    sandboxToken: (workerId) =>
      runtime.runPromise(issueSandboxToken(workerId, 600) as Effect.Effect<string, never, any>),
    registerSharedWorker: async (name = "shared-box") => {
      const admin = { channelId: ADMIN_CHANNEL, userId: ADMIN_USER, name: "Admin" };
      const command = fakeCommand(admin, "register-worker", { shared: "true" })!;
      const reply = await forwardCommand(target, command, fetch);
      const token = /sh -s -- (\S+)/.exec(reply.content)![1]!;
      const credentials = await registerDevice({ server: url, token, name }, fetch);
      const mcp = await worker(credentials.secret);
      await mcp.callTool({
        name: "worker_heartbeat",
        arguments: { workerId: credentials.workerId, workerType: "local" },
      });
      return { workerId: credentials.workerId, secret: credentials.secret, mcp };
    },
    stop: async () => {
      await Promise.all(clients.map((c) => c.close()));
      await coordinator.stop();
      await adapter.stop();
      oauth?.stop();
      await cdn.stop(true);
      await gmail?.stop(true);
      await web?.stop(true);
      await authRuntime?.dispose();
      await runtime.dispose();
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
