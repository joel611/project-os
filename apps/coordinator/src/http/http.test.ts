import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  AgentRuntimeError,
  ClassifierError,
  IntentClassifier,
  WorkerRepository,
  writeMemory,
} from "@project-os/core";
import { LocalLive, openLocalDb } from "@project-os/infra-local";
import { classifierReturning, makeTestLayer } from "@project-os/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.ts";
import { type HandleInboundConfig, type HttpEnv } from "./routes.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()));
});

const appFor = (layer: Layer.Layer<HttpEnv>, inbound?: HandleInboundConfig) => {
  const runtime = ManagedRuntime.make(layer);
  disposers.push(() => runtime.dispose());
  return createApp(
    {},
    { http: { run: (effect) => runtime.runPromise(effect), ...(inbound && { inbound }) } },
  );
};

type App = ReturnType<typeof appFor>;
const call = async (app: App, method: string, path: string, body?: unknown) => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
};

const inbound = (overrides: Record<string, unknown> = {}) => ({
  channelType: "discord",
  externalId: "m1",
  channelId: "c1",
  sender: { id: "u1" },
  content: "please build a thing",
  raw: {},
  receivedAt: T0,
  ...overrides,
});

const setup = (config?: HandleInboundConfig) => {
  const { layer, sent } = makeTestLayer({
    classifier: classifierReturning("new_request"),
    sandboxPool: [{ workerType: "daytona_pi" }],
  });
  return { app: appFor(layer, config), sent };
};

const linkedProject = async (app: App, source: Record<string, unknown> = {}) => {
  const project = await call(app, "POST", "/projects", { orgId: "o1", name: "Acme" });
  const linked = await call(app, "POST", `/projects/${project.body.id}/sources`, {
    type: "discord_channel",
    externalId: "c1",
    name: "#acme",
    alias: "acme",
    ...source,
  });
  return { project: project.body, source: linked.body };
};

describe("projects and sources", () => {
  it("creates and lists projects", async () => {
    const { app } = setup();
    const created = await call(app, "POST", "/projects", {
      orgId: "o1",
      name: "Acme",
      slug: "acme",
      customInstructions: "Be brief",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Acme",
      slug: "acme",
      customInstructions: "Be brief",
      status: "active",
      createdAt: T0,
    });
    const list = await call(app, "GET", "/projects");
    expect(list.body).toEqual([created.body]);
  });

  it("defaults optional project fields", async () => {
    const { app } = setup();
    const created = await call(app, "POST", "/projects", { orgId: "o1", name: "Acme" });
    expect(created.body).toMatchObject({ slug: null, customInstructions: "" });
  });

  it("rejects an invalid project body with 400", async () => {
    const { app } = setup();
    const res = await call(app, "POST", "/projects", { name: "no org" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("SchemaError");
  });

  it("patches project settings and leaves omitted fields alone", async () => {
    const { app } = setup();
    const created = await call(app, "POST", "/projects", {
      orgId: "o1",
      name: "Acme",
      customInstructions: "Be brief",
    });
    const res = await call(app, "PATCH", `/projects/${created.body.id}`, { name: "Acme 2" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Acme 2", customInstructions: "Be brief" });
    const got = await call(app, "GET", `/projects/${created.body.id}`);
    expect(got.body.project.name).toBe("Acme 2");
  });

  it("rejects an empty project name and 404s an unknown project on PATCH", async () => {
    const { app } = setup();
    const created = await call(app, "POST", "/projects", { orgId: "o1", name: "Acme" });
    expect((await call(app, "PATCH", `/projects/${created.body.id}`, { name: "" })).status).toBe(
      400,
    );
    expect((await call(app, "PATCH", "/projects/nope", { name: "x" })).status).toBe(404);
  });

  it("links a source, optionally as the default response", async () => {
    const { app } = setup();
    const { project, source } = await linkedProject(app, { isDefaultResponse: true });
    expect(source).toMatchObject({
      projectId: project.id,
      type: "discord_channel",
      direction: "both",
      isDefaultResponse: true,
      status: "active",
    });
  });

  it("links a non-default source without touching the default flag", async () => {
    const { app } = setup();
    const { source } = await linkedProject(app);
    expect(source.isDefaultResponse).toBe(false);
  });

  it("404s when linking a source to an unknown project", async () => {
    const { app } = setup();
    const res = await call(app, "POST", "/projects/nope/sources", {
      type: "discord_channel",
      externalId: "c1",
      name: "x",
      alias: "x",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("ProjectNotFound");
  });

  it("409s when the channel is already linked", async () => {
    const { app } = setup();
    await linkedProject(app);
    const other = await call(app, "POST", "/projects", { orgId: "o1", name: "Other" });
    const res = await call(app, "POST", `/projects/${other.body.id}/sources`, {
      type: "discord_channel",
      externalId: "c1",
      name: "dup",
      alias: "dup",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("SourceAlreadyLinked");
  });

  it("requires an alias, unique and well-formed within the project", async () => {
    const { app } = setup();
    const { project } = await linkedProject(app, { description: "  where the team talks  " });
    const add = (body: Record<string, unknown>) =>
      call(app, "POST", `/projects/${project.id}/sources`, {
        type: "github_repo",
        externalId: "acme/web",
        name: "acme/web",
        ...body,
      });
    expect((await add({})).status).toBe(400);
    expect(await add({ alias: "ACME" })).toMatchObject({
      status: 409,
      body: { error: "SourceAliasTaken" },
    });
    expect(await add({ alias: "not ok!" })).toMatchObject({
      status: 400,
      body: { error: "InvalidSourceAlias" },
    });
    expect(await add({ alias: " Web Site " })).toMatchObject({
      status: 201,
      body: { alias: "web-site", description: null },
    });
    const got = await call(app, "GET", `/projects/${project.id}`);
    expect(got.body.sources.map((s: { alias: string }) => s.alias).toSorted()).toEqual([
      "acme",
      "web-site",
    ]);
    expect(got.body.sources.find((s: { alias: string }) => s.alias === "acme").description).toBe(
      "where the team talks",
    );
  });

  it("PATCHes a source's alias and description", async () => {
    const { app } = setup();
    const { project, source } = await linkedProject(app);
    await call(app, "POST", `/projects/${project.id}/sources`, {
      type: "github_repo",
      externalId: "acme/web",
      name: "acme/web",
      alias: "web",
    });
    const patch = (body: Record<string, unknown>, id = source.id) =>
      call(app, "PATCH", `/projects/${project.id}/sources/${id}`, body);

    expect(await patch({ alias: "Team Chat", description: "daily chatter" })).toMatchObject({
      status: 200,
      body: { alias: "team-chat", description: "daily chatter" },
    });
    expect(await patch({ description: null })).toMatchObject({
      body: { alias: "team-chat", description: null },
    });
    expect(await patch({ alias: "web" })).toMatchObject({
      status: 409,
      body: { error: "SourceAliasTaken" },
    });
    expect((await patch({ alias: "team-chat" })).status).toBe(200);
    expect((await patch({ alias: "x" }, "nope")).status).toBe(404);
  });

  it("rejects an invalid source body with 400", async () => {
    const { app } = setup();
    const { project } = await linkedProject(app);
    const res = await call(app, "POST", `/projects/${project.id}/sources`, { type: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("POST /inbound", () => {
  it("rejects a message that violates the contract with 400", async () => {
    const { app } = setup();
    const res = await call(app, "POST", "/inbound", { content: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("SchemaError");
  });

  it("502s when the intent classifier fails", async () => {
    const { layer } = makeTestLayer();
    const failing = Layer.succeed(IntentClassifier, {
      classify: () => Effect.fail(new ClassifierError({ message: "down" })),
    });
    const app = appFor(Layer.provideMerge(failing, layer) as Layer.Layer<HttpEnv>);
    await linkedProject(app);
    const res = await call(app, "POST", "/inbound", inbound());
    expect(res).toMatchObject({ status: 502, body: { error: "ClassifierError" } });
  });

  it("reports unlinked channels", async () => {
    const { app } = setup();
    const res = await call(app, "POST", "/inbound", inbound());
    expect(res).toMatchObject({ status: 200, body: { kind: "unlinked" } });
  });

  it("turns a message in a linked channel into a ticket, visible through the admin API", async () => {
    const { app } = setup();
    const { project } = await linkedProject(app);
    const res = await call(app, "POST", "/inbound", inbound());
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("ticket_created");
    const ticketId = res.body.ticket.id;

    const list = await call(app, "GET", `/projects/${project.id}/tickets`);
    expect(list.body.map((t: { id: string }) => t.id)).toEqual([ticketId]);

    const detail = await call(app, "GET", `/tickets/${ticketId}`);
    expect(detail.body.ticket).toMatchObject({ id: ticketId, projectId: project.id });
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      "created",
      "assigned",
    ]);
  });

  it("deduplicates redelivered messages", async () => {
    const { app } = setup();
    await linkedProject(app);
    await call(app, "POST", "/inbound", inbound());
    const again = await call(app, "POST", "/inbound", inbound());
    expect(again.body).toEqual({ kind: "duplicate" });
  });

  it("applies the configured HandleInboundConfig", async () => {
    const { app } = setup({ requireMention: true });
    await linkedProject(app);
    const res = await call(app, "POST", "/inbound", inbound());
    expect(res.body).toEqual({ kind: "not_mentioned" });
  });
});

describe("tickets", () => {
  it("404s for unknown tickets and unknown projects", async () => {
    const { app } = setup();
    const ticket = await call(app, "GET", "/tickets/nope");
    expect(ticket).toMatchObject({ status: 404, body: { error: "TicketNotFound" } });
    const tickets = await call(app, "GET", "/projects/nope/tickets");
    expect(tickets).toMatchObject({ status: 404, body: { error: "ProjectNotFound" } });
  });

  it("only lists tickets of the requested project", async () => {
    const { app } = setup();
    await linkedProject(app);
    await call(app, "POST", "/inbound", inbound());
    const other = await call(app, "POST", "/projects", { orgId: "o1", name: "Other" });
    const list = await call(app, "GET", `/projects/${other.body.id}/tickets`);
    expect(list.body).toEqual([]);
  });

  const createTicket = async (app: App) => {
    await linkedProject(app, { isDefaultResponse: true });
    const res = await call(app, "POST", "/inbound", inbound());
    return res.body.ticket.id as string;
  };

  it("completing a ticket runs onTicketCompleted and replies in the ticket's thread", async () => {
    const { app, sent } = setup();
    const id = await createTicket(app);
    sent.length = 0; // the thread-opened note
    const started = await call(app, "POST", `/tickets/${id}/status`, { status: "in_progress" });
    expect(started.status).toBe(200);
    expect(sent).toHaveLength(0);

    const done = await call(app, "POST", `/tickets/${id}/status`, { status: "completed" });
    expect(done.body.status).toBe("completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channelType: "discord",
      channelId: "c1",
      threadId: "thread-1",
    });
  });

  it("does not reply for non-completing transitions", async () => {
    const { app, sent } = setup();
    const id = await createTicket(app);
    sent.length = 0; // the thread-opened note
    const res = await call(app, "POST", `/tickets/${id}/status`, {
      status: "failed",
      error: "boom",
    });
    expect(res.body).toMatchObject({ status: "failed", error: "boom" });
    expect(sent).toHaveLength(0);
  });

  it("409s on an invalid transition and 404s on unknown tickets", async () => {
    const { app } = setup();
    const id = await createTicket(app);
    const bad = await call(app, "POST", `/tickets/${id}/status`, { status: "completed" });
    expect(bad).toMatchObject({ status: 409, body: { error: "InvalidTransition" } });
    const missing = await call(app, "POST", "/tickets/nope/status", { status: "failed" });
    expect(missing.status).toBe(404);
  });

  it("502s when the agent runtime fails while composing the reply", async () => {
    const { layer } = makeTestLayer({
      classifier: classifierReturning("new_request"),
      sandboxPool: [{ workerType: "daytona_pi" }],
    });
    const failing = Layer.succeed(AgentRuntime, {
      respond: () => Effect.fail(new AgentRuntimeError({ message: "down" })),
    });
    const app = appFor(Layer.provideMerge(failing, layer) as Layer.Layer<HttpEnv>);
    const id = await createTicket(app);
    await call(app, "POST", `/tickets/${id}/status`, { status: "in_progress" });
    const res = await call(app, "POST", `/tickets/${id}/status`, { status: "completed" });
    expect(res).toMatchObject({ status: 502, body: { error: "AgentRuntimeError" } });
  });

  it("rejects an unknown status with 400", async () => {
    const { app } = setup();
    const res = await call(app, "POST", "/tickets/x/status", { status: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("dashboard reads", () => {
  const seeded = () => {
    const { layer } = makeTestLayer();
    const runtime = ManagedRuntime.make(layer);
    disposers.push(() => runtime.dispose());
    const app = createApp({}, { http: { run: (effect) => runtime.runPromise(effect) } });
    return { app, runtime };
  };

  it("returns a project with its sources, and 404s for unknown projects", async () => {
    const { app } = setup();
    const { project, source } = await linkedProject(app);
    const res = await call(app, "GET", `/projects/${project.id}`);
    expect(res).toEqual({ status: 200, body: { project, sources: [source] } });
    const missing = await call(app, "GET", "/projects/nope");
    expect(missing).toMatchObject({ status: 404, body: { error: "ProjectNotFound" } });
  });

  it("lists a project's memory, and 404s for unknown projects", async () => {
    const { app, runtime } = seeded();
    const { project } = await linkedProject(app);
    await runtime.runPromise(
      writeMemory({ projectId: project.id, type: "note", title: "Stack", content: "Bun" }),
    );
    const res = await call(app, "GET", `/projects/${project.id}/memory`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([{ projectId: project.id, title: "Stack", content: "Bun" }]);
    const missing = await call(app, "GET", "/projects/nope/memory");
    expect(missing).toMatchObject({ status: 404, body: { error: "ProjectNotFound" } });
  });

  it("lists workers with online/offline derived from lastSeenAt", async () => {
    const { app, runtime } = seeded();
    const beat = (workerId: string, at: string) =>
      runtime.runPromise(
        Effect.flatMap(WorkerRepository, (repo) =>
          repo.heartbeat({ workerId, workerType: "local_claude", ticketId: null, at }),
        ),
      );
    await beat("fresh", T0);
    await beat("stale", "2026-11-03T23:00:00.000Z");
    const res = await call(app, "GET", "/workers");
    expect(res.status).toBe(200);
    expect(res.body.map((w: { id: string; status: string }) => [w.id, w.status]).sort()).toEqual([
      ["fresh", "online"],
      ["stale", "offline"],
    ]);
  });
});

describe("GET /activity", () => {
  it("returns in-flight tickets with origin and reply channel, their events, and workers", async () => {
    const { app } = setup();
    await linkedProject(app, { isDefaultResponse: true });
    const created = await call(
      app,
      "POST",
      "/inbound",
      inbound({ sender: { id: "u1", name: "mira.k" } }),
    );
    const res = await call(app, "GET", "/activity");
    expect(res.status).toBe(200);
    expect(res.body.now).toBe(T0);
    expect(res.body.tickets).toMatchObject([
      {
        id: created.body.ticket.id,
        status: "assigned",
        origin: { channelType: "discord", sender: { id: "u1", name: "mira.k" } },
        replyChannel: "discord",
      },
    ]);
    expect(res.body.events.map((e: { type: string }) => e.type)).toEqual(["created", "assigned"]);
    expect(res.body.workers).toEqual([]);
  });

  it("only returns what changed since the given time", async () => {
    const { app } = setup();
    await linkedProject(app);
    await call(app, "POST", "/inbound", inbound());
    const later = await call(app, "GET", "/activity?since=2026-11-04T00:00:01.000Z");
    expect(later.body).toMatchObject({ tickets: [], events: [] });
    const same = await call(app, "GET", `/activity?since=${T0}`);
    expect(same.body.events).toHaveLength(2);
  });

  it("rejects a since that is not a timestamp", async () => {
    const { app } = setup();
    const res = await call(app, "GET", "/activity?since=yesterday");
    expect(res.status).toBe(400);
  });
});

describe("with the infra-local Layer (SQLite)", () => {
  it("serves the full flow on a real SQLite file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-http-"));
    try {
      const dbPath = join(dir, "test.sqlite");
      const seed = openLocalDb(dbPath);
      seed.sqlite.run(`INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'Org', '${T0}')`);
      seed.sqlite.close();

      const classifier = Layer.succeed(IntentClassifier, {
        classify: () => Effect.succeed({ intent: "new_request", confidence: 1 }),
      });
      const workerLauncher = {
        pool: Effect.succeed([{ workerType: "daytona_pi" as const }]),
        launch: () => Effect.void,
      };
      const app = appFor(
        Layer.mergeAll(LocalLive({ dbPath, adapterUrls: {}, workerLauncher }), classifier),
      );

      const { project } = await linkedProject(app);
      const res = await call(app, "POST", "/inbound", inbound());
      expect(res.body.kind).toBe("ticket_created");
      const list = await call(app, "GET", `/projects/${project.id}/tickets`);
      expect(list.body).toHaveLength(1);
      const detail = await call(app, "GET", `/tickets/${list.body[0].id}`);
      expect(detail.body.events).toHaveLength(2);
      const activity = await call(app, "GET", `/activity?since=${T0}`);
      expect(activity.body.events.map((e: { type: string }) => e.type)).toEqual([
        "created",
        "assigned",
      ]);
    } finally {
      await Promise.all(disposers.splice(0).map((d) => d()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
