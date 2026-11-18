import {
  addSkillsToSet,
  browseSkillSource,
  checkSkillUpdates,
  createSkillSet,
  deleteSkillSet,
  getSkillSet,
  handleInbound,
  listSkillSets,
  ProjectRepository,
  ProjectSourceRepository,
  removeSkillFromSet,
  skillBundleForTicket,
  skillSetChoices,
  TicketRepository,
  updateSkillSet,
  updateSkillsInSet,
} from "@project-os/core";
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

describe("skill sets", () => {
  it("creates, lists, renames and deletes sets", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* createSkillSet({ name: "  development ", description: " code " });
        yield* createSkillSet({ name: "writing", description: "" });
        const renamed = yield* updateSkillSet(set.id, { name: "dev", description: "more code" });
        const kept = yield* updateSkillSet(set.id, {});
        const sameName = yield* updateSkillSet(set.id, { name: "dev" });
        const listed = yield* listSkillSets;
        const one = yield* getSkillSet(set.id);
        yield* deleteSkillSet(set.id);
        const after = yield* listSkillSets;
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
        yield* createSkillSet({ name: "dev", description: "" });
        yield* createSkillSet({ name: "dev", description: "" });
      }),
      "SkillSetNameTaken",
    );
    await fails(createSkillSet({ name: "  ", description: "" }), "InvalidSkillSet");
    await fails(createSkillSet({ name: "x".repeat(61), description: "" }), "InvalidSkillSet");
    await fails(createSkillSet({ name: "None", description: "" }), "InvalidSkillSet");
    await fails(
      Effect.gen(function* () {
        yield* createSkillSet({ name: "a", description: "" });
        const b = yield* createSkillSet({ name: "b", description: "" });
        yield* updateSkillSet(b.id, { name: "a" });
      }),
      "SkillSetNameTaken",
    );
    await fails(updateSkillSet("nope", { name: "x" }), "SkillSetNotFound");
    await fails(deleteSkillSet("nope"), "SkillSetNotFound");
    await fails(getSkillSet("nope"), "SkillSetNotFound");
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
        const set = yield* createSkillSet({ name: "dev", description: "" });
        const added = yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd"],
          by: "Olga",
        });
        // Adding the same skill again replaces it rather than duplicating it.
        yield* addSkillsToSet({ setId: set.id, source: "acme/skills", slugs: ["tdd"], by: null });
        const detail = yield* getSkillSet(set.id);
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
        const set = yield* createSkillSet({ name: "dev", description: "" });
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
        const set = yield* createSkillSet({ name: "dev", description: "" });
        return yield* addSkillsToSet({ setId: set.id, source: "a/b", slugs: ["odd"], by: null });
      }),
      source,
    );
    expect(added[0]).toMatchObject({ name: "odd", description: "" });
  });

  it("refuses an unknown set, a bad source and a skill the repo doesn't have", async () => {
    await fails(
      addSkillsToSet({ setId: "nope", source: "acme/skills", slugs: ["tdd"], by: null }),
      "SkillSetNotFound",
    );
    await fails(
      Effect.gen(function* () {
        const set = yield* createSkillSet({ name: "dev", description: "" });
        yield* addSkillsToSet({ setId: set.id, source: "???", slugs: ["tdd"], by: null });
      }),
      "InvalidSkillSource",
    );
    await fails(
      Effect.gen(function* () {
        const set = yield* createSkillSet({ name: "dev", description: "" });
        yield* addSkillsToSet({ setId: set.id, source: "acme/skills", slugs: ["nope"], by: null });
      }),
      "InvalidSkillSource",
    );
  });

  it("removes a skill from its set", async () => {
    const out = await run(
      Effect.gen(function* () {
        const set = yield* createSkillSet({ name: "dev", description: "" });
        const [skill] = yield* addSkillsToSet({
          setId: set.id,
          source: "acme/skills",
          slugs: ["tdd", "review"],
          by: null,
        });
        yield* removeSkillFromSet(skill!.id);
        return (yield* getSkillSet(set.id)).skills.map((s) => s.slug);
      }),
    );
    expect(out).toEqual(["review"]);
    await fails(removeSkillFromSet("nope"), "SkillNotFound");
  });
});

describe("updating pinned skills", () => {
  const setup = (source: ReturnType<typeof upstream>) =>
    Effect.gen(function* () {
      const set = yield* createSkillSet({ name: "dev", description: "" });
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
        const set = yield* createSkillSet({ name: "dev", description: "" });
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
        const still = yield* getSkillSet(set.id);
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
    await fails(checkSkillUpdates("nope"), "SkillSetNotFound");
  });

  it("fetches only the changed skills, all or the ones named", async () => {
    const source = upstream();
    const layer = makeTestLayer({ skillSource: source }).layer;
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const set = yield* createSkillSet({ name: "dev", description: "" });
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
        const detail = yield* getSkillSet(set.id);
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
    await fails(updateSkillsInSet({ setId: "nope", by: null }), "SkillSetNotFound");
    await fails(
      Effect.gen(function* () {
        const set = yield* createSkillSet({ name: "dev", description: "" });
        yield* updateSkillsInSet({ setId: set.id, skillIds: ["ghost"], by: null });
      }),
      "SkillNotFound",
    );
  });
});

describe("skillSetChoices", () => {
  it("offers only sets that have skills", async () => {
    const out = await run(
      Effect.gen(function* () {
        const empty = yield* createSkillSet({ name: "empty", description: "nothing" });
        const dev = yield* createSkillSet({ name: "dev", description: "code" });
        yield* addSkillsToSet({ setId: dev.id, source: "acme/skills", slugs: ["tdd"], by: null });
        return { empty, dev, choices: yield* skillSetChoices };
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

describe("skillBundleForTicket", () => {
  const world = (skillSetId: string | null | "missing") =>
    Effect.gen(function* () {
      const set = yield* createSkillSet({ name: "dev", description: "" });
      yield* addSkillsToSet({
        setId: set.id,
        source: "acme/skills",
        slugs: ["tdd", "review"],
        by: null,
      });
      yield* (yield* TicketRepository).insert(
        T("t1", {
          skillSetId: skillSetId === "missing" ? "ghost" : (skillSetId ?? set.id),
        }) as never,
      );
      return set;
    });
  const caller = { id: "w1", kind: "device" } as const;

  it("hands the ticket's worker the pinned files of its set", async () => {
    const bundle = await run(
      Effect.gen(function* () {
        const set = yield* world(null);
        return { set, bundle: yield* skillBundleForTicket("t1", caller) };
      }),
    );
    expect(bundle.bundle.set).toEqual({ id: bundle.set.id, name: "dev" });
    expect(bundle.bundle.skills.map((s) => s.slug)).toEqual(["review", "tdd"]);
    expect(bundle.bundle.skills[1]!.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "examples/a.ts",
    ]);
  });

  it("is empty for a ticket with no set, or whose set was deleted", async () => {
    const none = await run(
      Effect.gen(function* () {
        yield* (yield* TicketRepository).insert(T("t2") as never);
        return yield* skillBundleForTicket("t2", caller);
      }),
    );
    expect(none).toEqual({ set: null, skills: [] });
    const gone = await run(
      Effect.gen(function* () {
        yield* world("missing");
        return yield* skillBundleForTicket("t1", caller);
      }),
    );
    expect(gone).toEqual({ set: null, skills: [] });
  });

  it("refuses any worker but the ticket's own", async () => {
    await fails(
      Effect.gen(function* () {
        yield* world(null);
        yield* skillBundleForTicket("t1", { id: "w2", kind: "device" });
      }),
      "WorkerUnauthorized",
    );
    await fails(skillBundleForTicket("nope", caller), "TicketNotFound");
  });
});

describe("routing a request to a skill set", () => {
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
        offered.push(input.skillSets);
        return Effect.succeed({
          intent: "new_request",
          confidence: 1,
          ...(answer && { skillSet: answer(devId) }),
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
        const dev = yield* createSkillSet({ name: "dev", description: "code" });
        devId = dev.id;
        if (skills) {
          yield* addSkillsToSet({ setId: dev.id, source: "acme/skills", slugs: ["tdd"], by: null });
        }
        const outcome = yield* handleInbound(inbound, {});
        if (outcome.kind !== "ticket_created") throw new Error(outcome.kind);
        return yield* (yield* TicketRepository).get(outcome.ticket.id);
      }).pipe(Effect.provide(layer)) as never,
    );
    return { ticket: ticket as { skillSetId?: string | null }, offered, devId };
  };

  it("offers the sets to Jev and stores the one it picks on the ticket", async () => {
    const out = await route((id) => ({ choice: id, confidence: 0.9 }));
    expect(out.offered).toEqual([[{ id: out.devId, name: "dev", description: "code" }]]);
    expect(out.ticket.skillSetId).toBe(out.devId);
  });

  it("starts the ticket with no set when Jev says none or is unsure", async () => {
    expect(
      (await route(() => ({ choice: "none", confidence: 0.99 }))).ticket.skillSetId,
    ).toBeNull();
    expect((await route((id) => ({ choice: id, confidence: 0.4 }))).ticket.skillSetId).toBeNull();
    expect((await route(undefined)).ticket.skillSetId).toBeNull();
  });

  it("doesn't ask about skills when no set has any", async () => {
    const out = await route(undefined, false);
    expect(out.offered).toEqual([undefined]);
  });
});
