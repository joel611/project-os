import {
  addSource,
  createProject,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
} from "@project-os/core";
import type { Ticket } from "@project-os/core";
import { makeTestLayer } from "@project-os/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeAdminActions, type AdminEnv } from "./actions.ts";
import { seedDefaults } from "./seed.ts";

const T0 = "2026-11-04T00:00:00.000Z";

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()));
});

/** One in-memory world per test; `run` and the admin actions share its state. */
const setup = (options?: Parameters<typeof makeTestLayer>[0]) => {
  const runtime = ManagedRuntime.make(makeTestLayer(options).layer);
  disposers.push(() => runtime.dispose());
  const run = <A>(effect: Effect.Effect<A, unknown, AdminEnv>) =>
    runtime.runPromise(effect as Effect.Effect<A, never, AdminEnv>);
  return { run, actions: makeAdminActions({ run, orgId: "o1" }) };
};

describe("AdminActions", () => {
  it("createProject creates a project in the configured org", async () => {
    const { run, actions } = setup();
    expect(await actions.createProject({ name: "Acme", customInstructions: "be brief" })).toMatch(
      /Created project "Acme"/,
    );
    expect(await run(Effect.flatMap(ProjectRepository, (r) => r.list))).toMatchObject([
      { name: "Acme", orgId: "o1", customInstructions: "be brief" },
    ]);
  });

  it("createProject works without custom instructions", async () => {
    const { actions } = setup();
    expect(await actions.createProject({ name: "Plain" })).toMatch(/Plain/);
  });

  it("createProject creates the project's channel and makes it the reply channel", async () => {
    const { run, actions } = setup();
    expect(await actions.createProject({ name: "Acme" })).toMatch(
      /Created project "Acme" .* Created channel #Acme \(chan-1\) as its reply channel/,
    );
    const sources = await run(
      Effect.flatMap(ProjectSourceRepository, (r) => r.findByExternal("discord_channel", "chan-1")),
    );
    expect(sources).toMatchObject({ isDefaultResponse: true });
  });

  it("createProject with createChannel=false only creates the project", async () => {
    const { actions } = setup();
    expect(await actions.createProject({ name: "Acme", createChannel: false })).toMatch(
      /^Created project "Acme" \(id [^)]+\)\.$/,
    );
  });

  it("createProject reports a failed channel create and keeps the project", async () => {
    const { run, actions } = setup({ failChannelCreate: "Missing Permissions" });
    expect(await actions.createProject({ name: "Acme" })).toMatch(
      /Created project "Acme" .* Could not create its channel \(Missing Permissions\)/,
    );
    expect(await run(Effect.flatMap(ProjectRepository, (r) => r.list))).toHaveLength(1);
  });

  it("reports failures as text, not exceptions", async () => {
    const { actions } = setup();
    expect(
      await actions.addSource({ projectId: "nope", type: "discord", externalId: "c1" }),
    ).toMatch(/ProjectNotFound/);
    expect(await actions.setDefaultChannel({ projectId: "nope", externalId: "c1" })).toMatch(
      /ProjectNotFound/,
    );
    expect(await actions.ticketStatus({ ticketId: "nope" })).toMatch(/TicketNotFound/);
  });

  it("adds a source, sets the default channel, then reports ticket status", async () => {
    const { run, actions } = setup();
    const project = await run(createProject({ orgId: "o1", name: "Acme" }));

    expect(
      await actions.addSource({ projectId: project.id, type: "discord", externalId: "c1" }),
    ).toMatch(/Linked discord_channel c1/);
    expect(
      await actions.addSource({ projectId: project.id, type: "email", externalId: "a@b.c" }),
    ).toMatch(/email_address/);
    expect(
      await actions.addSource({ projectId: project.id, type: "github_repo", externalId: "o/r" }),
    ).toMatch(/github_repo/);
    expect(
      await actions.addSource({ projectId: project.id, type: "carrier-pigeon", externalId: "x" }),
    ).toMatch(/Unknown source type/);
    expect(
      await actions.addSource({ projectId: project.id, type: "discord", externalId: "c1" }),
    ).toMatch(/SourceAlreadyLinked/);

    expect(await actions.setDefaultChannel({ projectId: project.id, externalId: "c1" })).toMatch(
      /Default reply channel .* c1/,
    );

    const ticket: Ticket = {
      id: "t1",
      projectId: project.id,
      status: "open",
      title: "Do it",
      intent: "new_request",
      inputSummary: "do it",
      priority: null,
      workerType: null,
      workerId: null,
      result: null,
      error: null,
      createdAt: T0,
      assignedAt: null,
      startedAt: null,
      lastActivityAt: T0,
      completedAt: null,
      updatedAt: T0,
    };
    await run(Effect.flatMap(TicketRepository, (r) => r.insert(ticket)));
    expect(await actions.ticketStatus({ ticketId: "t1" })).toBe('Ticket t1 "Do it": open');
  });
});

describe("seedDefaults", () => {
  const input = { orgId: "o1", projectName: "Demo", discordChannelId: "c1" };

  it("creates the project and a default Discord source", async () => {
    const { layer } = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.provide(seedDefaults(input), layer as Layer.Layer<AdminEnv>),
    );
    expect(result.created).toEqual({ project: true, source: true });
    expect(result.source).toMatchObject({
      type: "discord_channel",
      externalId: "c1",
      isDefaultResponse: true,
    });
  });

  it("is idempotent", async () => {
    const { layer } = makeTestLayer();
    const twice = Effect.gen(function* () {
      const first = yield* seedDefaults(input);
      const second = yield* seedDefaults(input);
      const projects = yield* Effect.flatMap(ProjectRepository, (r) => r.list);
      return { first, second, projects };
    });
    const { first, second, projects } = await Effect.runPromise(
      Effect.provide(twice, layer as Layer.Layer<AdminEnv>),
    );
    expect(second.created).toEqual({ project: false, source: false });
    expect(second.project.id).toBe(first.project.id);
    expect(second.source.id).toBe(first.source.id);
    expect(projects).toHaveLength(1);
  });

  it("makes an existing, non-default source the default", async () => {
    const { layer } = makeTestLayer();
    const program = Effect.gen(function* () {
      const project = yield* createProject({ orgId: "o1", name: "Demo" });
      yield* addSource({
        projectId: project.id,
        type: "discord_channel",
        externalId: "c1",
        name: "c1",
      });
      return yield* seedDefaults(input);
    });
    const result = await Effect.runPromise(Effect.provide(program, layer as Layer.Layer<AdminEnv>));
    expect(result.created).toEqual({ project: false, source: false });
    expect(result.source.isDefaultResponse).toBe(true);
  });

  it("fails if the channel belongs to another project", async () => {
    const { layer } = makeTestLayer();
    const program = Effect.gen(function* () {
      const other = yield* createProject({ orgId: "o1", name: "Other" });
      yield* addSource({
        projectId: other.id,
        type: "discord_channel",
        externalId: "c1",
        name: "c1",
      });
      return yield* Effect.flip(seedDefaults(input));
    });
    const error = await Effect.runPromise(Effect.provide(program, layer as Layer.Layer<AdminEnv>));
    expect(error._tag).toBe("SourceAlreadyLinked");
  });
});
