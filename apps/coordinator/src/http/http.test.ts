import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntentClassifier } from "@project-os/core";
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
  const { layer, sent } = makeTestLayer({ classifier: classifierReturning("new_request") });
  return { app: appFor(layer, config), sent };
};

const linkedProject = async (app: App, source: Record<string, unknown> = {}) => {
  const project = await call(app, "POST", "/projects", { orgId: "o1", name: "Acme" });
  const linked = await call(app, "POST", `/projects/${project.body.id}/sources`, {
    type: "discord_channel",
    externalId: "c1",
    name: "#acme",
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
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("SourceAlreadyLinked");
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
    const { app } = setup({ workerId: "w1" });
    await linkedProject(app);
    const res = await call(app, "POST", "/inbound", inbound());
    expect(res.body.ticket.workerId).toBe("w1");
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

  it("completing a ticket runs onTicketCompleted and replies via the default source", async () => {
    const { app, sent } = setup();
    const id = await createTicket(app);
    const started = await call(app, "POST", `/tickets/${id}/status`, { status: "in_progress" });
    expect(started.status).toBe(200);
    expect(sent).toHaveLength(0);

    const done = await call(app, "POST", `/tickets/${id}/status`, { status: "completed" });
    expect(done.body.status).toBe("completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelType: "discord", channelId: "c1" });
  });

  it("does not reply for non-completing transitions", async () => {
    const { app, sent } = setup();
    const id = await createTicket(app);
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

  it("rejects an unknown status with 400", async () => {
    const { app } = setup();
    const res = await call(app, "POST", "/tickets/x/status", { status: "bogus" });
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
      const app = appFor(Layer.mergeAll(LocalLive({ dbPath, adapterUrls: {} }), classifier));

      const { project } = await linkedProject(app);
      const res = await call(app, "POST", "/inbound", inbound());
      expect(res.body.kind).toBe("ticket_created");
      const list = await call(app, "GET", `/projects/${project.id}/tickets`);
      expect(list.body).toHaveLength(1);
      const detail = await call(app, "GET", `/tickets/${list.body[0].id}`);
      expect(detail.body.events).toHaveLength(2);
    } finally {
      await Promise.all(disposers.splice(0).map((d) => d()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
