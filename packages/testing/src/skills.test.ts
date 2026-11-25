import {
  addSkillsToSet,
  browseSkillSource,
  checkSkillUpdates,
  createTaskType,
  deleteTaskType,
  getTaskType,
  handleInbound,
  listTaskTypes,
  ProjectRepository,
  ProjectSourceRepository,
  removeSkillFromSet,
  SkillRepository,
  skillArchiveForTicket,
  taskTypeForTicket,
  withTaskType,
  taskTypeChoices,
  TicketRepository,
  updateTaskType,
  updateSkillsInSet,
  AssetStore,
  AssetStoreFailed,
} from "@project-os/core";
import { strFromU8, unzipSync } from "fflate";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { IntentClassifier } from "@project-os/core";
import { makeSkillSourceFake, makeTestLayer } from "./index.ts";

const T0 = "2026-11-04T00:00:00.000Z";

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`;

const upstream = () =>
  makeSkillSourceFake({
    "acme/skills": [
      {
        path: "skills/tdd",
        sha: "tree-1",
        files: [
          { path: "SKILL.md", contents: skillMd("Test-driven", "Red green refactor") },
          { path: "examples/a.ts", contents: "export {}" },
        ],
      },
      {
        path: "skills/review",
        sha: "tree-2",
        files: [{ path: "SKILL.md", contents: skillMd("Review", "Review a PR") }],
      },
    ],
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, never> | Effect.Effect<A, E, any>,
  source = upstream(),
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(makeTestLayer({ skillSource: source }).layer)) as any,
  ) as Promise<A>;

const fails = async (effect: Effect.Effect<any, any, any>, tag: string) => {
  const layer = makeTestLayer({ skillSource: upstream() }).layer;
  const exit = await Effect.runPromise(
    effect.pipe(
      Effect.flip,
      Effect.map((e: { _tag: string }) => e._tag),
      Effect.provide(layer),
    ) as any,
  );
  expect(exit).toBe(tag);
};

describe("task types", () => {
  it("creates, lists, renames and deletes sets", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "  development ", description: " code " });
        yield* createTaskType({ name: "writing", description: "" });
        const renamed = yield* updateTaskType(set.id, { name: "dev", description: "more code" });
        const kept = yield* updateTaskType(set.id, {});
        const sameName = yield* updateTaskType(set.id, { name: "dev" });
        const listed = yield* listTaskTypes;
        const one = yield* getTaskType(set.id);
        yield* deleteTaskType(set.id);
        const after = yield* listTaskTypes;
        return { set, renamed, kept, sameName, listed, one, after };
      }),
    );
    expect(out.set).toMatchObject({ name: "development", description: "code" });
    expect(out.renamed).toMatchObject({ name: "dev", description: "more code" });
    expect(out.kept.name).toBe("dev");
    expect(out.sameName.name).toBe("dev");
    expect(out.listed.sets.map((s) => s.set.name)).toEqual(["dev", "writing"]);
    expect(out.one.skills).toEqual([]);
    expect(out.after.sets.map((s) => s.set.name)).toEqual(["writing"]);
  });

  it("refuses duplicate, empty, long and reserved names", async () => {
    await fails(
      Effect.gen(function* () {
        yield* createTaskType({ name: "dev", description: "" });
        yield* createTaskType({ name: "dev", description: "" });
      }),
      "TaskTypeNameTaken",
    );
    await fails(createTaskType({ name: "  ", description: "" }), "InvalidTaskType");
    await fails(createTaskType({ name: "x".repeat(61), description: "" }), "InvalidTaskType");
    await fails(createTaskType({ name: "None", description: "" }), "InvalidTaskType");
    await fails(
      Effect.gen(function* () {
        yield* createTaskType({ name: "a", description: "" });
        const b = yield* createTaskType({ name: "b", description: "" });
        yield* updateTaskType(b.id, { name: "a" });
      }),
      "TaskTypeNameTaken",
    );
    await fails(updateTaskType("nope", { name: "x" }), "TaskTypeNotFound");
    await fails(deleteTaskType("nope"), "TaskTypeNotFound");
    await fails(getTaskType("nope"), "TaskTypeNotFound");
  });
});

describe("browsing and adding skills", () => {
  it("lists a repo's skills, narrowing to one when the link names it", async () => {
    const all = await run(browseSkillSource("https://skills.sh/acme/skills"));
    expect(all.source).toBe("acme/skills");
    expect(all.skills.map((s) => s.slug)).toEqual(["tdd", "review"]);
    expect(all.skills[0]).toMatchObject({ name: "Test-driven", description: "Red green refactor" });
    const one = await run(browseSkillSource("https://skills.sh/acme/skills/review"));
    expect(one.skills.map((s) => s.slug)).toEqual(["review"]);
  });

  it("refuses links that are not skills sources, and repos that can't be read", async () => {
    await fails(browseSkillSource("https://example.com/a/b"), "InvalidSkillSource");
    await fails(browseSkillSource("acme/missing"), "SkillFetchFailed");
  });

  it("pins the ticked skills with their files and who added them", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        const added = yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd"],
          by: "Olga",
        });
        // Adding the same skill again replaces it rather than duplicating it.
        yield* addSkillsToSet({ setId: set.id, source: "acme/skills", slugs: ["tdd"], by: null });
        const detail = yield* getTaskType(set.id);
        return { added, detail };
      }),
    );
    expect(out.added[0]).toMatchObject({
      source: "acme/skills",
      slug: "tdd",
      name: "Test-driven",
      description: "Red green refactor",
      path: "skills/tdd",
      sha: "tree-1",
      fileCount: 2,
      fetchedBy: "Olga",
    });
    expect(out.added[0]!.bytes).toBeGreaterThan(0);
    expect(out.detail.skills).toHaveLength(1);
    expect(out.detail.skills[0]!.id).toBe(out.added[0]!.id);
  });

  it("names a skill by its slug when SKILL.md has no frontmatter", async () => {
    const source = makeSkillSourceFake({
      "a/b": [{ path: "x/plain", sha: "s", files: [{ path: "SKILL.md", contents: "# plain" }] }],
    });
    const added = await run(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        return yield* addSkillsToSet({ setId: set.id, source: "a/b", slugs: ["plain"], by: null });
      }),
      source,
    );
    expect(added[0]).toMatchObject({ name: "plain", description: "" });
  });

  it("pins a folder that turns out to have no SKILL.md under the slug", async () => {
    const source = makeSkillSourceFake({
      "a/b": [{ path: "x/odd", sha: "s", files: [{ path: "README.md", contents: "hi" }] }],
    });
    const added = await run(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        return yield* addSkillsToSet({ setId: set.id, source: "a/b", slugs: ["odd"], by: null });
      }),
      source,
    );
    expect(added[0]).toMatchObject({ name: "odd", description: "" });
  });

  it("refuses an unknown set, a bad source and a skill the repo doesn't have", async () => {
    await fails(
      addSkillsToSet({ setId: "nope", source: "acme/skills", slugs: ["tdd"], by: null }),
      "TaskTypeNotFound",
    );
    await fails(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        yield* addSkillsToSet({ setId: set.id, source: "???", slugs: ["tdd"], by: null });
      }),
      "InvalidSkillSource",
    );
    await fails(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        yield* addSkillsToSet({ setId: set.id, source: "acme/skills", slugs: ["nope"], by: null });
      }),
      "InvalidSkillSource",
    );
  });

  it("removes a skill from its set", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        const [skill] = yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd", "review"],
          by: null,
        });
        yield* removeSkillFromSet(skill!.id);
        return (yield* getTaskType(set.id)).skills.map((s) => s.slug);
      }),
    );
    expect(out).toEqual(["review"]);
    await fails(removeSkillFromSet("nope"), "SkillNotFound");
  });
});

describe("updating pinned skills", () => {
  const setup = (source: ReturnType<typeof upstream>) =>
    Effect.gen(function* () {
      const set = yield* createTaskType({ name: "dev", description: "" });
      yield* addSkillsToSet({
        setId: set.id,
        source: "acme/skills",
        slugs: ["tdd", "review"],
        by: null,
      });
      return set;
    }).pipe(Effect.provide(makeTestLayer({ skillSource: source }).layer));

  it("reports current, changed and vanished skills without touching the pin", async () => {
    const source = upstream();
    const layer = makeTestLayer({ skillSource: source }).layer;
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd", "review"],
          by: null,
        });
        source.publish("acme/skills", {
          path: "skills/tdd",
          sha: "tree-9",
          files: [{ path: "SKILL.md", contents: skillMd("Test-driven", "v2") }],
        });
        source.remove("acme/skills", "skills/review");
        const checked = yield* checkSkillUpdates(set.id);
        const still = yield* getTaskType(set.id);
        return { checked, still };
      }).pipe(Effect.provide(layer)),
    );
    const byState = Object.fromEntries(
      report.checked.statuses.map((s) => {
        const slug = report.still.skills.find((k) => k.id === s.skillId)!.slug;
        return [slug, s.state];
      }),
    );
    expect(byState).toEqual({ tdd: "update_available", review: "missing" });
    expect(report.still.skills.find((s) => s.slug === "tdd")!.sha).toBe("tree-1");
    await fails(checkSkillUpdates("nope"), "TaskTypeNotFound");
  });

  it("fetches only the changed skills, all or the ones named", async () => {
    const source = upstream();
    const layer = makeTestLayer({ skillSource: source }).layer;
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        const [tdd, review] = yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd", "review"],
          by: null,
        });
        const nothing = yield* updateSkillsInSet({ setId: set.id, by: "Olga" });
        source.publish("acme/skills", {
          path: "skills/tdd",
          sha: "tree-9",
          files: [{ path: "SKILL.md", contents: skillMd("Test-driven", "v2") }],
        });
        source.publish("acme/skills", {
          path: "skills/review",
          sha: "tree-8",
          files: [{ path: "SKILL.md", contents: skillMd("Review", "v2") }],
        });
        const named = yield* updateSkillsInSet({
          setId: set.id,
          skillIds: [review!.id],
          by: "Olga",
        });
        const rest = yield* updateSkillsInSet({ setId: set.id, by: "Olga" });
        const detail = yield* getTaskType(set.id);
        return { tdd, nothing, named, rest, detail };
      }).pipe(Effect.provide(layer)),
    );
    expect(out.nothing).toEqual([]);
    expect(out.named.map((s) => s.slug)).toEqual(["review"]);
    expect(out.rest.map((s) => s.slug)).toEqual(["tdd"]);
    expect(out.detail.skills.map((s) => [s.slug, s.sha, s.fetchedBy])).toEqual([
      ["review", "tree-8", "Olga"],
      ["tdd", "tree-9", "Olga"],
    ]);
    // The skill keeps its id across an update.
    expect(out.rest[0]!.id).toBe(out.tdd!.id);
  });

  it("leaves a skill that vanished upstream pinned", async () => {
    const source = upstream();
    const layer = makeTestLayer({ skillSource: source }).layer;
    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const set = yield* setup(source).pipe(Effect.provide(layer));
        source.remove("acme/skills", "skills/tdd");
        return yield* updateSkillsInSet({ setId: set.id, by: null });
      }).pipe(Effect.provide(layer)),
    );
    expect(updated).toEqual([]);
  });

  it("refuses an unknown set or a skill that isn't in it", async () => {
    await fails(updateSkillsInSet({ setId: "nope", by: null }), "TaskTypeNotFound");
    await fails(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        yield* updateSkillsInSet({ setId: set.id, skillIds: ["ghost"], by: null });
      }),
      "SkillNotFound",
    );
  });
});

describe("taskTypeChoices", () => {
  it("offers only sets that have skills", async () => {
    const out = await run(
      Effect.gen(function* () {
        const empty = yield* createTaskType({ name: "empty", description: "nothing" });
        const dev = yield* createTaskType({ name: "dev", description: "code" });
        yield* addSkillsToSet({ setId: dev.id, source: "acme/skills", slugs: ["tdd"], by: null });
        return { empty, dev, choices: yield* taskTypeChoices };
      }),
    );
    expect(out.choices).toEqual([{ id: out.dev.id, name: "dev", description: "code" }]);
  });
});

const T = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  projectId: "p1",
  status: "assigned" as const,
  title: "t",
  intent: null,
  inputSummary: "t",
  priority: null,
  workerType: "local" as const,
  workerId: "w1",
  requester: null,
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: null,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
  ...over,
});

const updateTaskTypeInstructions = (set: { readonly id: string }) =>
  updateTaskType(set.id, { instructions: "  Use tdd first.  " });

describe("skillArchiveForTicket", () => {
  const world = (taskTypeId: string | null | "missing") =>
    Effect.gen(function* () {
      const set = yield* createTaskType({ name: "dev", description: "" });
      yield* addSkillsToSet({
        setId: set.id,
        source: "acme/skills",
        slugs: ["tdd", "review"],
        by: null,
      });
      yield* (yield* TicketRepository).insert(
        T("t1", {
          taskTypeId: taskTypeId === "missing" ? "ghost" : (taskTypeId ?? set.id),
        }) as never,
      );
      return set;
    });
  const caller = { id: "w1", kind: "device" } as const;
  const entries = (zip: Uint8Array | null) =>
    Object.fromEntries(Object.entries(unzipSync(zip!)).map(([k, v]) => [k, strFromU8(v)]));

  it("hands the ticket's worker one zip of its set's pinned skills, entries <slug>/<path>", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* world(null);
        return { set, archive: yield* skillArchiveForTicket("t1", caller) };
      }),
    );
    expect(out.archive.set).toEqual({ id: out.set.id, name: "dev" });
    expect(entries(out.archive.archive)).toEqual({
      "review/SKILL.md": skillMd("Review", "Review a PR"),
      "tdd/SKILL.md": skillMd("Test-driven", "Red green refactor"),
      "tdd/examples/a.ts": "export {}",
    });
  });

  it("is empty for a ticket with no set, a deleted set or a set with no skills", async () => {
    const none = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(T("t2") as never);
        return yield* skillArchiveForTicket("t2", { id: "w1", kind: "device" });
      }),
    );
    expect(none).toEqual({ set: null, archive: null });
    const gone = await run(
      Effect.gen(function* () {
        yield* world("missing");
        return yield* skillArchiveForTicket("t1", caller);
      }),
    );
    expect(gone).toEqual({ set: null, archive: null });
    const empty = await run(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "empty", description: "" });
        yield* (yield* TicketRepository).insert(T("t3", { taskTypeId: set.id }) as never);
        return yield* skillArchiveForTicket("t3", caller);
      }),
    );
    expect(empty).toEqual({ set: null, archive: null });
  });

  it("names the ticket's task type for display, and says null for none or a deleted one", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* world(null);
        const tickets = yield* TicketRepository;
        const detail = (id: string) => withTaskType({ ticket: T(id) as never, events: [] });
        yield* tickets.insert(T("t4", { taskTypeId: "ghost" }) as never);
        return {
          set,
          named: yield* withTaskType({ ticket: yield* tickets.get("t1"), events: [] }),
          none: yield* detail("t9"),
          deleted: yield* withTaskType({ ticket: yield* tickets.get("t4"), events: [] }),
        };
      }),
    );
    expect(out.named.taskType).toEqual({ id: out.set.id, name: "dev" });
    expect(out.none.taskType).toBeNull();
    expect(out.deleted.taskType).toBeNull();
  });

  it("gives a worker its ticket's task type with instructions, null when it has none", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* updateTaskTypeInstructions(yield* world(null));
        yield* (yield* TicketRepository).insert(T("t5") as never);
        return {
          set,
          mine: yield* taskTypeForTicket("t1", caller),
          none: yield* taskTypeForTicket("t5", { id: "w1", kind: "device" }),
        };
      }),
    );
    expect(out.mine).toEqual({ id: out.set.id, name: "dev", instructions: "Use tdd first." });
    expect(out.none).toBeNull();
    await fails(
      Effect.gen(function* () {
        yield* world(null);
        yield* taskTypeForTicket("t1", { id: "w2", kind: "device" });
      }),
      "WorkerUnauthorized",
    );
  });

  it("refuses any worker but the ticket's own", async () => {
    await fails(
      Effect.gen(function* () {
        yield* world(null);
        yield* skillArchiveForTicket("t1", { id: "w2", kind: "device" });
      }),
      "WorkerUnauthorized",
    );
    await fails(skillArchiveForTicket("nope", caller), "TicketNotFound");
  });

  it("says so when a stored zip is gone, or storage can't be read", async () => {
    await fails(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        const [skill] = yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd"],
          by: null,
        });
        // A copy whose zip was never stored (or was lost).
        yield* (yield* SkillRepository).upsertSkill({
          ...skill!,
          archiveKey: "skills/missing.zip",
        });
        yield* (yield* TicketRepository).insert(T("t1", { taskTypeId: set.id }) as never);
        yield* skillArchiveForTicket("t1", caller);
      }),
      "SkillFetchFailed",
    );
  });

  it("says so when file storage can't be read", async () => {
    await fails(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        yield* addSkillsToSet({ setId: set.id, source: "acme/skills", slugs: ["tdd"], by: null });
        yield* (yield* TicketRepository).insert(T("t1", { taskTypeId: set.id }) as never);
        const real = yield* AssetStore;
        yield* skillArchiveForTicket("t1", caller).pipe(
          Effect.provideService(AssetStore, {
            ...real,
            get: () => Effect.fail(new AssetStoreFailed({ message: "r2 down" })),
          }),
        );
      }),
      "SkillFetchFailed",
    );
  });

  it("can't add a skill while file storage is down", async () => {
    const source = upstream();
    const layer = makeTestLayer({ skillSource: source, failAssetStore: "disk full" }).layer;
    const message = await Effect.runPromise(
      Effect.gen(function* () {
        const set = yield* createTaskType({ name: "dev", description: "" });
        return yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd"],
          by: null,
        });
      }).pipe(
        Effect.flip,
        Effect.map((e) => (e as { message: string }).message),
        Effect.provide(layer),
      ),
    );
    expect(message).toContain("disk full");
  });
});

describe("routing a request to a task type", () => {
  const inbound = {
    channelType: "discord" as const,
    channelId: "c1",
    externalId: "m1",
    sender: { id: "u1", name: "Ann" },
    content: "fix the login bug",
    receivedAt: T0,
  } as never;

  /** Handles one message with Jev answering `answer(devId)`; `skills` says whether the set has any. */
  const route = async (
    answer: ((devId: string) => { choice: string; confidence: number }) | undefined,
    skills = true,
  ) => {
    const offered: unknown[] = [];
    let devId = "";
    const classifier = Layer.succeed(IntentClassifier, {
      classify: (input) => {
        offered.push(input.taskTypes);
        return Effect.succeed({
          intent: "new_request",
          confidence: 1,
          ...(answer && { taskType: answer(devId) }),
        });
      },
    });
    const { layer } = makeTestLayer({ classifier, skillSource: upstream() });
    const ticket = await Effect.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* ProjectRepository).insert({
          id: "p1",
          orgId: "o1",
          name: "P",
          slug: null,
          customInstructions: "",
          defaultResponseChannelId: null,
          channelDigest: false,
          channelDigestNotify: false,
          status: "active",
          createdBy: null,
          createdAt: T0,
          updatedAt: T0,
        } as never);
        yield* (yield* ProjectSourceRepository).insert({
          id: "s1",
          projectId: project.id,
          type: "discord_channel",
          externalId: "c1",
          name: "c",
          alias: "chat",
          description: null,
          direction: "both",
          isDefaultResponse: true,
          config: null,
          status: "active",
          connectedBy: null,
          createdAt: T0,
          updatedAt: T0,
        } as never);
        const dev = yield* createTaskType({ name: "dev", description: "code" });
        devId = dev.id;
        if (skills) {
          yield* addSkillsToSet({ setId: dev.id, source: "acme/skills", slugs: ["tdd"], by: null });
        }
        const outcome = yield* handleInbound(inbound, {});
        if (outcome.kind !== "ticket_created") throw new Error(outcome.kind);
        return yield* (yield* TicketRepository).get(outcome.ticket.id);
      }).pipe(Effect.provide(layer)) as never,
    );
    return { ticket: ticket as { taskTypeId?: string | null }, offered, devId };
  };

  it("offers the sets to Jev and stores the one it picks on the ticket", async () => {
    const out = await route((id) => ({ choice: id, confidence: 0.9 }));
    expect(out.offered).toEqual([[{ id: out.devId, name: "dev", description: "code" }]]);
    expect(out.ticket.taskTypeId).toBe(out.devId);
  });

  it("starts the ticket with no set when Jev says none or is unsure", async () => {
    expect(
      (await route(() => ({ choice: "none", confidence: 0.99 }))).ticket.taskTypeId,
    ).toBeNull();
    expect((await route((id) => ({ choice: id, confidence: 0.4 }))).ticket.taskTypeId).toBeNull();
    expect((await route(undefined)).ticket.taskTypeId).toBeNull();
  });

  it("doesn't ask about skills when no set has any", async () => {
    const out = await route(undefined, false);
    expect(out.offered).toEqual([undefined]);
  });
});
