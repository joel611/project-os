import { describe, expect, it } from "vite-plus/test";
import {
  chosenSkillSet,
  isSafeSkillPath,
  parseSkillFrontmatter,
  parseSkillSource,
  updateStatusOf,
  type Skill,
} from "./index.ts";

describe("parseSkillSource", () => {
  it.each([
    ["vercel-labs/skills", { source: "vercel-labs/skills" }],
    ["  vercel-labs/skills  ", { source: "vercel-labs/skills" }],
    ["vercel-labs/skills/find-skills", { source: "vercel-labs/skills", slug: "find-skills" }],
    ["https://skills.sh/vercel-labs/skills", { source: "vercel-labs/skills" }],
    [
      "https://www.skills.sh/vercel-labs/skills/find-skills",
      { source: "vercel-labs/skills", slug: "find-skills" },
    ],
    ["https://github.com/vercel-labs/skills", { source: "vercel-labs/skills" }],
    ["https://github.com/vercel-labs/skills.git", { source: "vercel-labs/skills" }],
    // A github.com link's third part is `tree`, not a skill name.
    ["https://github.com/vercel-labs/skills/tree", { source: "vercel-labs/skills" }],
    ["https://github.com/vercel-labs/skills/tree/main/skills", { source: "vercel-labs/skills" }],
    ["https://skills.sh/vercel-labs/skills/a/b", { source: "vercel-labs/skills" }],
  ])("reads %s", (input, expected) => {
    expect(parseSkillSource(input)).toEqual(expected);
  });

  it.each([
    "",
    "skills",
    "https://evil.example/vercel-labs/skills",
    "https://github.com/onlyowner",
    "not a url/at all",
    "-bad/repo",
    "ftp://skills.sh/a/b",
    "https://",
  ])("refuses %j", (input) => {
    expect(parseSkillSource(input)).toBeUndefined();
  });

  it("ignores a slug that is not a safe folder name", () => {
    expect(parseSkillSource("a/b/..")).toEqual({ source: "a/b" });
  });
});

describe("parseSkillFrontmatter", () => {
  it("reads name and description, quoted or not", () => {
    expect(
      parseSkillFrontmatter('---\nname: tdd\ndescription: "Test first"\nother: x\n---\n# Body'),
    ).toEqual({ name: "tdd", description: "Test first" });
    expect(parseSkillFrontmatter("---\r\nname: 'a'\r\ndescription: b c\r\n---\r\n")).toEqual({
      name: "a",
      description: "b c",
    });
  });

  it("gives empty strings when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# Just a body")).toEqual({ name: "", description: "" });
  });
});

describe("isSafeSkillPath", () => {
  it.each(["SKILL.md", "examples/app.ts", "a/b/c-d_e.md", "my file.md"])("allows %s", (p) =>
    expect(isSafeSkillPath(p)).toBe(true),
  );
  it.each([
    "",
    "/etc/passwd",
    "../x",
    "a/../b",
    "a//b",
    "./a",
    ".hidden",
    "a/.git/config",
    "a\\b",
    "a/b$",
    "x".repeat(201),
  ])("refuses %j", (p) => expect(isSafeSkillPath(p)).toBe(false));
});

describe("updateStatusOf", () => {
  const skill = { id: "k1", sha: "aaa" } as Skill;
  it("compares the pinned tree SHA with upstream's", () => {
    expect(updateStatusOf(skill, "aaa")).toEqual({
      skillId: "k1",
      state: "current",
      latestSha: "aaa",
    });
    expect(updateStatusOf(skill, "bbb").state).toBe("update_available");
    expect(updateStatusOf(skill, null)).toEqual({
      skillId: "k1",
      state: "missing",
      latestSha: null,
    });
  });
});

describe("chosenSkillSet", () => {
  it("is the set Jev is sure of, else null", () => {
    expect(chosenSkillSet({})).toBeNull();
    expect(chosenSkillSet({ skillSet: { choice: "s1", confidence: 0.9 } })).toBe("s1");
    expect(chosenSkillSet({ skillSet: { choice: "s1", confidence: 0.5 } })).toBeNull();
    expect(chosenSkillSet({ skillSet: { choice: "none", confidence: 0.99 } })).toBeNull();
  });
});
