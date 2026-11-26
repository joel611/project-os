import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_SKILLS, frontmatterOf, parseSkillUri, skillEntry, skillUri } from "./index.ts";

describe("built-in skills", () => {
  it("each skill's frontmatter name and description match its listing", () => {
    for (const s of BUILTIN_SKILLS) {
      const fm = frontmatterOf(s.files["SKILL.md"]!);
      expect(fm.name).toBe(s.name);
      expect(fm.description).toBe(s.description);
    }
  });

  it("round-trips skill URIs and refuses other schemes", () => {
    expect(parseSkillUri(skillUri("a", "x/y.md"))).toEqual({ name: "a", path: "x/y.md" });
    expect(parseSkillUri("skill://a")).toEqual({ name: "a", path: "" });
    expect(parseSkillUri("https://a/b")).toBeUndefined();
    expect(parseSkillUri("skill://")).toBeUndefined();
  });

  it("lists a sha256 digest for every file", async () => {
    const entry = await skillEntry(BUILTIN_SKILLS[0]!);
    expect(entry.resources[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
