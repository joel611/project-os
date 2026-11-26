import { MEMORY_SKILL } from "./memory.ts";
import { SOURCES_SKILL } from "./sources.ts";
import { TICKETS_SKILL } from "./tickets.ts";

/** A first-party skill: the Agent Skills layout, one `SKILL.md` plus optional supporting files. */
export interface BuiltinSkill {
  /** Equals the frontmatter `name` and the last segment of its `skill://` URI. */
  readonly name: string;
  readonly description: string;
  /** Paths are relative to the skill root; `SKILL.md` is always present. */
  readonly files: Readonly<Record<string, string>>;
}

const skill = (name: string, description: string, skillMd: string): BuiltinSkill => ({
  name,
  description,
  files: { "SKILL.md": skillMd },
});

/** Skills the Coordinator ships about itself: how to use its own MCP tools. Bundled, not stored. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  skill(
    "project-os-tickets",
    "How a Project OS Worker works its ticket through the Coordinator MCP tools (claim, progress, ask, attach, finish). Use at the start of a session and whenever you are unsure how to report on a ticket.",
    TICKETS_SKILL,
  ),
  skill(
    "project-os-memory",
    "When and how to read and write Project OS project memory (and find project sources). Use before starting work for context, and before saving anything durable.",
    MEMORY_SKILL,
  ),
  skill(
    "project-os-accounts",
    "How a Project OS Worker reaches the requesting person's Google Drive, GitHub and ClickUp (user_token or the credential proxy). Use before reading or writing any of those.",
    SOURCES_SKILL,
  ),
];

export const SKILL_URI_SCHEME = "skill://";

export const skillUri = (name: string, path = ""): string =>
  `${SKILL_URI_SCHEME}${name}${path === "" ? "" : `/${path}`}`;

/** Splits `skill://<name>[/<path>]`; undefined for any other shape. */
export const parseSkillUri = (uri: string): { name: string; path: string } | undefined => {
  if (!uri.startsWith(SKILL_URI_SCHEME)) return undefined;
  const [name, ...rest] = uri.slice(SKILL_URI_SCHEME.length).split("/");
  if (!name) return undefined;
  return { name, path: rest.join("/") };
};

/** The frontmatter `name` and `description` of a `SKILL.md`, as the listing carries them. */
export const frontmatterOf = (skillMd: string): Record<string, string> => {
  const match = /^---\n([\s\S]*?)\n---/.exec(skillMd);
  const out: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

export const findSkill = (name: string): BuiltinSkill | undefined =>
  BUILTIN_SKILLS.find((s) => s.name === name);

const sha256 = async (text: string): Promise<{ digest: string; size: number }> => {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { digest: `sha256:${hex}`, size: bytes.length };
};

/** One `skills/list` entry: URI, frontmatter and the digest and size of every file. */
export const skillEntry = async (s: BuiltinSkill) => ({
  uri: skillUri(s.name, "SKILL.md"),
  frontmatter: frontmatterOf(s.files["SKILL.md"] ?? ""),
  resources: await Promise.all(
    Object.entries(s.files).map(async ([path, content]) => ({
      uri: skillUri(s.name, path),
      ...(await sha256(content)),
    })),
  ),
});
