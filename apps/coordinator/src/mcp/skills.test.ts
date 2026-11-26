import { describe, expect, it } from "vite-plus/test";
import { readSkillFile } from "./skills.ts";

describe("readSkillFile", () => {
  it("reads SKILL.md for the skill root and for its explicit path", () => {
    const root = readSkillFile("skill://project-os-tickets");
    expect(root).toContain("name: project-os-tickets");
    expect(readSkillFile("skill://project-os-tickets/SKILL.md")).toBe(root);
  });

  it("is undefined for other schemes, unknown skills and unknown files", () => {
    expect(readSkillFile("https://example.com/SKILL.md")).toBeUndefined();
    expect(readSkillFile("skill://nope/SKILL.md")).toBeUndefined();
    expect(readSkillFile("skill://project-os-tickets/other.md")).toBeUndefined();
  });
});
