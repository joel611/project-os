import {
  addSource,
  AgentRuntime,
  AgentRuntimeError,
  appendEvent,
  getTicket,
  createProject,
  createProjectWithChannel,
  handleInbound,
  notifyTicket,
  ProjectSourceRepository,
  setDefaultChannel,
  TicketRepository,
  updateStatusAndNotify,
  type Ticket,
} from "@project-os/core";
import type { InboundMessage } from "@project-os/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { classifierReturning, makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const run = <A, E>(
  effect: Effect.Effect<A, E, any>,
  options?: Parameters<typeof makeTestLayer>[0],
) => {
  const { layer, sent } = makeTestLayer(options);
  return { sent, result: Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E>) };
};

describe("createProject", () => {
  it("creates an active project with defaults", async () => {
    const project = await run(createProject({ orgId: "o1", name: "Acme" })).result;
    expect(project).toMatchObject({
      orgId: "o1",
      name: "Acme",
      slug: null,
      customInstructions: "",
      status: "active",
    });
  });

  it("keeps slug and custom instructions", async () => {
    const project = await run(
      createProject({ orgId: "o1", name: "Acme", slug: "acme", customInstructions: "be brief" }),
    ).result;
    expect(project).toMatchObject({ slug: "acme", customInstructions: "be brief" });
  });
});

describe("createProjectWithChannel", () => {
  const program = Effect.gen(function* () {
    const result = yield* createProjectWithChannel({ orgId: "o1", name: "Acme" });
    const sources = yield* Effect.flatMap(ProjectSourceRepository, (r) =>
      r.listByProject(result.project.id),
    );
    return { result, sources };
  });

  it("creates the project, its Discord channel, and links it as the default", async () => {
    const { layer, createdChannels } = makeTestLayer();
    const { result, sources } = await Effect.runPromise(Effect.provide(program, layer));
    expect(createdChannels).toEqual([{ channelType: "discord", name: "Acme" }]);
    expect(result.channelError).toBeNull();
    expect(result.source).toMatchObject({ externalId: "chan-1", name: "#Acme" });
    expect(sources).toMatchObject([
      { type: "discord_channel", externalId: "chan-1", isDefaultResponse: true },
    ]);
  });

  it("keeps the project and reports why when the channel can't be created", async () => {
    const { layer } = makeTestLayer({ failChannelCreate: "Missing Permissions" });
    const { result, sources } = await Effect.runPromise(Effect.provide(program, layer));
    expect(result.project.name).toBe("Acme");
    expect(result).toMatchObject({ source: null, channelError: "Missing Permissions" });
    expect(sources).toEqual([]);
  });
});

describe("addSource", () => {
  const program = Effect.gen(function* () {
    const project = yield* createProject({ orgId: "o1", name: "Acme" });
    const first = yield* addSource({
      projectId: project.id,
      type: "discord_channel",
      externalId: "c1",
      name: "#acme",
    });
    return { project, first };
  });

  it("links a source with default direction", async () => {
    const { first } = await run(program).result;
    expect(first).toMatchObject({ direction: "both", isDefaultResponse: false, status: "active" });
  });

  it("can mark the new source as default response", async () => {
    const sources = await run(
      Effect.gen(function* () {
        const { project } = yield* program;
        yield* addSource({
          projectId: project.id,
          type: "discord_channel",
          externalId: "c2",
          name: "#two",
          direction: "outbound",
          isDefaultResponse: true,
          config: { a: 1 },
        });
        return yield* (yield* ProjectSourceRepository).listByProject(project.id);
      }),
    ).result;
    expect(sources.find((s) => s.externalId === "c2")).toMatchObject({
      isDefaultResponse: true,
      direction: "outbound",
      config: { a: 1 },
    });
  });

  it("fails for an unknown project", async () => {
    const error = await run(
      Effect.flip(
        addSource({ projectId: "nope", type: "discord_channel", externalId: "c1", name: "x" }),
      ),
    ).result;
    expect(error._tag).toBe("ProjectNotFound");
  });

  it("rejects a channel already linked", async () => {
    const error = await run(
      Effect.gen(function* () {
        const { project } = yield* program;
        return yield* Effect.flip(
          addSource({
            projectId: project.id,
            type: "discord_channel",
            externalId: "c1",
            name: "again",
          }),
        );
      }),
    ).result;
    expect(error._tag).toBe("SourceAlreadyLinked");
  });
});

describe("setDefaultChannel", () => {
  const twoChannels = Effect.gen(function* () {
    const project = yield* createProject({ orgId: "o1", name: "Acme" });
    for (const externalId of ["c1", "c2"]) {
      yield* addSource({
        projectId: project.id,
        type: "discord_channel",
        externalId,
        name: externalId,
      });
    }
    return project;
  });

  it("flags an existing source and clears the previous default", async () => {
    const sources = await run(
      Effect.gen(function* () {
        const project = yield* twoChannels;
        yield* setDefaultChannel({ projectId: project.id, externalId: "c1" });
        yield* setDefaultChannel({ projectId: project.id, externalId: "c2" });
        return yield* (yield* ProjectSourceRepository).listByProject(project.id);
      }),
    ).result;
    expect(sources.filter((s) => s.isDefaultResponse).map((s) => s.externalId)).toEqual(["c2"]);
  });

  it("links an unseen channel as the default", async () => {
    const source = await run(
      Effect.gen(function* () {
        const project = yield* twoChannels;
        return yield* setDefaultChannel({ projectId: project.id, externalId: "c3" });
      }),
    ).result;
    expect(source).toMatchObject({ externalId: "c3", isDefaultResponse: true });
  });

  it("refuses a channel linked to another project", async () => {
    const error = await run(
      Effect.gen(function* () {
        yield* twoChannels;
        const other = yield* createProject({ orgId: "o1", name: "Other" });
        return yield* Effect.flip(setDefaultChannel({ projectId: other.id, externalId: "c1" }));
      }),
    ).result;
    expect(error._tag).toBe("SourceAlreadyLinked");
  });

  it("fails for an unknown project", async () => {
    const error = await run(Effect.flip(setDefaultChannel({ projectId: "nope", externalId: "c1" })))
      .result;
    expect(error._tag).toBe("ProjectNotFound");
  });
});

describe("updateStatusAndNotify", () => {
  const ticket = (projectId: string): Ticket => ({
    id: "t1",
    projectId,
    status: "in_progress",
    title: "Do it",
    intent: "new_request",
    inputSummary: "do it",
    priority: null,
    workerType: "local",
    workerId: "w1",
    requester: null,
    result: { ok: true },
    error: null,
    createdAt: T0,
    assignedAt: T0,
    startedAt: T0,
    lastActivityAt: T0,
    completedAt: null,
    updatedAt: T0,
  });
  const setup = Effect.gen(function* () {
    const project = yield* createProject({ orgId: "o1", name: "Acme" });
    yield* addSource({
      projectId: project.id,
      type: "discord_channel",
      externalId: "c1",
      name: "#acme",
      isDefaultResponse: true,
    });
    yield* (yield* TicketRepository).insert(ticket(project.id));
  });

  it("sends the reply when the ticket completes", async () => {
    const r = run(
      Effect.gen(function* () {
        yield* setup;
        return yield* updateStatusAndNotify({ ticketId: "t1", status: "completed" });
      }),
    );
    expect((await r.result).status).toBe("completed");
    expect(r.sent).toHaveLength(1);
  });

  it("tells the thread when the ticket is blocked, with no reason to share", async () => {
    const r = run(
      Effect.gen(function* () {
        yield* setup;
        return yield* updateStatusAndNotify({ ticketId: "t1", status: "blocked" });
      }),
    );
    expect((await r.result).status).toBe("blocked");
    expect(r.sent.map((s) => s.content)).toEqual([
      'Ticket "Do it" is blocked and needs input before it can continue.',
    ]);
  });

  describe("blocked with the Worker's own words", () => {
    const summarizing = (respond: (prompt: string) => Effect.Effect<string, AgentRuntimeError>) =>
      Effect.provideService(AgentRuntime, { respond: ({ prompt }) => respond(prompt) });
    const block = (input: { reason?: string }, ticketOver: Partial<Ticket> = {}) =>
      Effect.gen(function* () {
        const project = yield* createProject({ orgId: "o1", name: "Acme" });
        yield* addSource({
          projectId: project.id,
          type: "discord_channel",
          externalId: "c1",
          name: "#acme",
          isDefaultResponse: true,
        });
        yield* (yield* TicketRepository).insert({ ...ticket(project.id), ...ticketOver });
      }).pipe(
        Effect.andThen(updateStatusAndNotify({ ticketId: "t1", status: "blocked", ...input })),
      );
    const failing = Effect.fail(new AgentRuntimeError({ message: "model down" }));

    it("posts the Coordinator's short version of the reason, and keeps the reason on the ticket", async () => {
      const prompts: string[] = [];
      const r = run(
        Effect.gen(function* () {
          yield* block({
            reason:
              "  I tried the GitHub API with Ada's token and got 403 on acme/web: the GitHub App is not installed on that repo.  ",
          });
          return yield* getTicket({ ticketId: "t1" });
        }).pipe(
          summarizing((prompt) => {
            prompts.push(prompt);
            return Effect.succeed("  Install the GitHub App on acme/web.  ");
          }),
        ),
      );
      const { events } = await r.result;
      expect(r.sent.map((s) => s.content)).toEqual([
        'Ticket "Do it" is blocked: Install the GitHub App on acme/web.\nReply here and I\'ll pick it back up.',
      ]);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("the GitHub App is not installed on that repo");
      expect(events.at(-1)).toMatchObject({
        type: "status_update",
        actor: "worker",
        actorId: "w1",
        payload: { kind: "blocked_reason" },
        body: expect.stringMatching(/^I tried the GitHub API.*that repo\.$/),
      });
    });

    it("posts the Worker's exact words when the summary fails", async () => {
      const r = run(block({ reason: "Need the staging URL." }).pipe(summarizing(() => failing)));
      await r.result;
      expect(r.sent.map((s) => s.content)).toEqual([
        'Ticket "Do it" is blocked: Need the staging URL.\nReply here and I\'ll pick it back up.',
      ]);
    });

    it("posts the Worker's exact words when the summary comes back empty", async () => {
      const r = run(
        block({ reason: "Need the staging URL." }).pipe(summarizing(() => Effect.succeed("  "))),
      );
      await r.result;
      expect(r.sent[0]!.content).toContain("blocked: Need the staging URL.");
    });

    it("cuts an exact message that is too long for the channel", async () => {
      const r = run(block({ reason: "x".repeat(5000) }).pipe(summarizing(() => failing)));
      await r.result;
      const content = r.sent[0]!.content;
      expect(content).toContain(`${"x".repeat(1499)}…\n`);
      expect(content.length).toBeLessThan(1600);
    });

    it("falls back to the Worker's latest comment or status update when it gave no reason", async () => {
      const r = run(
        Effect.gen(function* () {
          const project = yield* createProject({ orgId: "o1", name: "Acme" });
          yield* addSource({
            projectId: project.id,
            type: "discord_channel",
            externalId: "c1",
            name: "#acme",
            isDefaultResponse: true,
          });
          yield* (yield* TicketRepository).insert(ticket(project.id));
          yield* appendEvent({
            ticketId: "t1",
            type: "comment",
            actor: "worker",
            body: "Waiting on the design file",
          });
          yield* appendEvent({
            ticketId: "t1",
            type: "comment",
            actor: "coordinator",
            body: "Status?",
          });
          yield* appendEvent({
            ticketId: "t1",
            type: "result",
            actor: "worker",
            body: "not a status",
          });
          yield* updateStatusAndNotify({ ticketId: "t1", status: "blocked", reason: "   " });
        }).pipe(summarizing(() => failing)),
      );
      await r.result;
      expect(r.sent[0]!.content).toContain("blocked: Waiting on the design file");
    });

    it("records the reason with no actor id when the ticket has no worker", async () => {
      const r = run(
        Effect.gen(function* () {
          yield* block({ reason: "Need help." }, { workerId: null });
          return yield* getTicket({ ticketId: "t1" });
        }).pipe(summarizing(() => failing)),
      );
      const { events } = await r.result;
      expect(events.at(-1)).toMatchObject({ actor: "worker", actorId: null, body: "Need help." });
    });
  });

  it("tells the thread when the ticket fails, with the reason", async () => {
    const r = run(
      Effect.gen(function* () {
        yield* setup;
        return yield* updateStatusAndNotify({ ticketId: "t1", status: "failed", error: "boom" });
      }),
    );
    expect((await r.result).status).toBe("failed");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.content).toContain("boom");
  });

  it("tells the thread a ticket failed even without a reason", async () => {
    const r = run(
      Effect.gen(function* () {
        yield* setup;
        return yield* updateStatusAndNotify({ ticketId: "t1", status: "failed" });
      }),
    );
    expect((await r.result).status).toBe("failed");
    expect(r.sent[0]?.content).toBe('Ticket "Do it" failed.');
  });

  it("sends no notice when the ticket has nowhere to post", async () => {
    const r = run(
      Effect.gen(function* () {
        const project = yield* createProject({ orgId: "o1", name: "Acme" });
        yield* (yield* TicketRepository).insert(ticket(project.id));
        return yield* notifyTicket("t1", "hello");
      }),
    );
    expect(await r.result).toBe(false);
    expect(r.sent).toHaveLength(0);
  });

  it("swallows a notice for a ticket that does not exist", async () => {
    const r = run(notifyTicket("missing", "hello"));
    expect(await r.result).toBe(false);
    expect(r.sent).toHaveLength(0);
  });

  it("passes the failure reason through", async () => {
    const t = await run(
      Effect.gen(function* () {
        yield* setup;
        return yield* updateStatusAndNotify({ ticketId: "t1", status: "failed", error: "boom" });
      }),
    ).result;
    expect(t).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("admin channel allow-list", () => {
  const message = (senderId: string): InboundMessage => ({
    channelType: "discord",
    externalId: `m-${senderId}`,
    channelId: "admin-chan",
    sender: { id: senderId },
    content: "create project Acme",
    raw: {},
    receivedAt: T0,
  });
  const options = { classifier: classifierReturning("admin_command") };
  const config = { adminChannelId: "admin-chan", adminUserIds: ["admin1"] };

  it("handles an allow-listed admin", async () => {
    const r = run(handleInbound(message("admin1"), config), options);
    expect(await r.result).toEqual({ kind: "admin_handled" });
  });

  it("refuses everyone else and says so", async () => {
    const r = run(handleInbound(message("intruder"), config), options);
    expect(await r.result).toEqual({ kind: "admin_forbidden" });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.content).toMatch(/not authorized/i);
  });

  it("an empty allow-list refuses everyone", async () => {
    const r = run(handleInbound(message("admin1"), { ...config, adminUserIds: [] }), options);
    expect(await r.result).toEqual({ kind: "admin_forbidden" });
  });

  it("does not gate when no allow-list is configured", async () => {
    const r = run(handleInbound(message("anyone"), { adminChannelId: "admin-chan" }), options);
    expect(await r.result).toEqual({ kind: "admin_handled" });
  });
});
