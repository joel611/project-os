import { makeSkillSourceFake, makeTestLayer } from "@project-os/testing";
import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Access } from "../access.ts";
import { httpRoutes } from "./routes.ts";

const OPERATOR: Access = {
  caller: async () => ({ kind: "user", userId: "u-op", name: "Olga", role: "admin" }),
  personOf: async () => undefined,
};

const md = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`;

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()));
});

const setup = () => {
  const source = makeSkillSourceFake({
    "acme/skills": [
      { path: "skills/tdd", sha: "t1", files: [{ path: "SKILL.md", contents: md("tdd", "v1") }] },
      { path: "skills/lint", sha: "l1", files: [{ path: "SKILL.md", contents: md("lint", "v1") }] },
    ],
  });
  const runtime = ManagedRuntime.make(makeTestLayer({ skillSource: source }).layer);
  disposers.push(() => runtime.dispose());
  const app = httpRoutes({ run: (e) => runtime.runPromise(e), access: OPERATOR });
  const call = async (method: string, path: string, body?: unknown) => {
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
  return { call, source };
};

describe("task type routes", () => {
  it("creates, reads, renames, lists and deletes a set", async () => {
    const { call } = setup();
    const created = await call("POST", "/task-types", { name: "development", description: "code" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await call("GET", `/task-types/${id}`)).body).toEqual({
      set: created.body,
      skills: [],
    });
    const renamed = await call("PATCH", `/task-types/${id}`, { description: "all the code" });
    expect(renamed.body).toMatchObject({ name: "development", description: "all the code" });
    expect((await call("GET", "/task-types")).body.sets).toHaveLength(1);
    expect((await call("DELETE", `/task-types/${id}`)).body).toEqual({ deleted: true });
    expect((await call("GET", "/task-types")).body.sets).toEqual([]);
  });

  it("defaults the description and instructions to empty", async () => {
    const { call } = setup();
    const created = await call("POST", "/task-types", { name: "plain" });
    expect(created.body.description).toBe("");
    expect(created.body.instructions).toBe("");
  });

  it("stores the instructions, trimmed, and changes them without touching the rest", async () => {
    const { call } = setup();
    const created = await call("POST", "/task-types", {
      name: "development",
      description: "code",
      instructions: "  Use tdd first.  ",
    });
    expect(created.body.instructions).toBe("Use tdd first.");
    const edited = await call("PATCH", `/task-types/${created.body.id}`, {
      instructions: "Use lint last.",
    });
    expect(edited.body).toMatchObject({
      name: "development",
      description: "code",
      instructions: "Use lint last.",
    });
  });

  it("answers with the right status for bad input", async () => {
    const { call } = setup();
    expect((await call("POST", "/task-types", {})).status).toBe(400);
    expect((await call("POST", "/task-types", { name: "none" })).status).toBe(400);
    await call("POST", "/task-types", { name: "dev" });
    expect((await call("POST", "/task-types", { name: "dev" })).status).toBe(409);
    expect((await call("GET", "/task-types/nope")).status).toBe(404);
    expect((await call("PATCH", "/task-types/nope", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/task-types/nope")).status).toBe(404);
  });

  it("browses a repo, then adds and removes the picked skills", async () => {
    const { call } = setup();
    const { body: set } = await call("POST", "/task-types", { name: "dev" });
    const browsed = await call("POST", "/task-types/browse", {
      source: "https://skills.sh/acme/skills",
    });
    expect(browsed.body.skills.map((s: { slug: string }) => s.slug)).toEqual(["tdd", "lint"]);
    expect(
      (await call("POST", "/task-types/browse", { source: "https://x.test/a/b" })).status,
    ).toBe(400);
    expect((await call("POST", "/task-types/browse", { source: "acme/missing" })).status).toBe(502);

    const added = await call("POST", `/task-types/${set.id}/skills`, {
      source: "acme/skills",
      slugs: ["tdd", "lint"],
    });
    expect(added.status).toBe(201);
    // Who clicked is recorded on the skill.
    expect(added.body.skills.map((s: { fetchedBy: string }) => s.fetchedBy)).toEqual([
      "Olga",
      "Olga",
    ]);
    expect(
      (await call("POST", `/task-types/${set.id}/skills`, { source: "acme/skills", slugs: [] }))
        .status,
    ).toBe(400);

    const skillId = added.body.skills[0].id as string;
    expect((await call("DELETE", `/task-types/${set.id}/skills/${skillId}`)).body).toEqual({
      deleted: true,
    });
    expect((await call("DELETE", `/task-types/${set.id}/skills/${skillId}`)).status).toBe(404);
    expect((await call("GET", `/task-types/${set.id}`)).body.skills).toHaveLength(1);
  });

  it("checks for updates, then updates all changed skills or just the named ones", async () => {
    const { call, source } = setup();
    const { body: set } = await call("POST", "/task-types", { name: "dev" });
    const added = await call("POST", `/task-types/${set.id}/skills`, {
      source: "acme/skills",
      slugs: ["tdd", "lint"],
    });
    const [tdd, lint] = added.body.skills as Array<{ id: string; slug: string }>;
    source.publish("acme/skills", {
      path: "skills/tdd",
      sha: "t2",
      files: [{ path: "SKILL.md", contents: md("tdd", "v2") }],
    });
    source.publish("acme/skills", {
      path: "skills/lint",
      sha: "l2",
      files: [{ path: "SKILL.md", contents: md("lint", "v2") }],
    });

    const report = await call("GET", `/task-types/${set.id}/updates`);
    expect(report.body.statuses.map((s: { state: string }) => s.state)).toEqual([
      "update_available",
      "update_available",
    ]);
    expect((await call("GET", "/task-types/nope/updates")).status).toBe(404);

    const named = await call("POST", `/task-types/${set.id}/update`, { skillIds: [lint!.id] });
    expect(named.body.skills.map((s: { slug: string }) => s.slug)).toEqual(["lint"]);
    const rest = await call("POST", `/task-types/${set.id}/update`);
    expect(rest.body.skills.map((s: { id: string }) => s.id)).toEqual([tdd!.id]);
    expect(
      (await call("POST", `/task-types/${set.id}/update`, { skillIds: ["ghost"] })).status,
    ).toBe(404);
    const detail = await call("GET", `/task-types/${set.id}`);
    expect(detail.body.skills.map((s: { sha: string }) => s.sha).sort()).toEqual(["l2", "t2"]);
  });
});
