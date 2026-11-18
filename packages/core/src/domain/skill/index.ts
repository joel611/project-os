import type {
  Skill,
  SkillBundle,
  SkillCandidate,
  SkillFile,
  SkillSet,
  SkillUpdateStatus,
} from "@project-os/contracts";
import { SAFE_SKILL_SLUG } from "@project-os/contracts";
import { Data } from "effect";

export type { Skill, SkillBundle, SkillCandidate, SkillFile, SkillSet, SkillUpdateStatus };

export class SkillSetNotFound extends Data.TaggedError("SkillSetNotFound")<{
  readonly skillSetId: string;
}> {}

export class SkillNotFound extends Data.TaggedError("SkillNotFound")<{
  readonly skillId: string;
}> {}

/** A set with this name exists already (names are what Jev chooses between). */
export class SkillSetNameTaken extends Data.TaggedError("SkillSetNameTaken")<{
  readonly setName: string;
}> {}

/** The name or description can't be used, e.g. the reserved name `none`. */
export class InvalidSkillSet extends Data.TaggedError("InvalidSkillSet")<{
  readonly message: string;
}> {}

/** The text is not a GitHub repo, a skills.sh link, or an `owner/repo` pair. */
export class InvalidSkillSource extends Data.TaggedError("InvalidSkillSource")<{
  readonly message: string;
}> {}

/** GitHub could not be read, or the skill is not something we will download. */
export class SkillFetchFailed extends Data.TaggedError("SkillFetchFailed")<{
  readonly message: string;
}> {}

/** Jev's "no skill set fits" answer. A set can't take this name. */
export const NO_SKILL_SET = "none";

/** Below this the skill-set answer is dropped and the Worker gets no skills. */
export const SKILL_SET_MIN_CONFIDENCE = 0.7;

/** What one skill may weigh: a skill is prose and a few scripts, not a dataset. */
export const SKILL_LIMITS = {
  maxFiles: 60,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
} as const;

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export interface SkillSourceRef {
  /** `owner/repo`. */
  readonly source: string;
  /** Set when the text named one skill (`skills.sh/owner/repo/slug`). */
  readonly slug?: string;
}

/**
 * Reads what a person pasted: `owner/repo`, `owner/repo/skill`, a `skills.sh` link or a
 * `github.com` link. Only GitHub-hosted skills are supported.
 */
export const parseSkillSource = (input: string): SkillSourceRef | undefined => {
  let text = input.trim();
  let fromGithub = false;
  if (/^https?:\/\//i.test(text)) {
    const url = safeUrl(text);
    const hostname = url?.hostname.replace(/^www\./, "");
    if (!url || (hostname !== "skills.sh" && hostname !== "github.com")) return undefined;
    fromGithub = hostname === "github.com";
    text = url.pathname.replace(/^\/+|\/+$/g, "");
  }
  const [owner, repo, slug, ...rest] = text.split("/");
  if (!owner || !repo) return undefined;
  const source = `${owner}/${repo.replace(/\.git$/, "")}`;
  if (!REPO.test(source)) return undefined;
  // github.com/<o>/<r>/tree/<branch>/... is a repo link, not a skill name.
  return !fromGithub && slug && rest.length === 0 && SAFE_SKILL_SLUG.test(slug)
    ? { source, slug }
    : { source };
};

const safeUrl = (text: string): URL | undefined => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

/** `name` and `description` from a SKILL.md's frontmatter; empty strings when it has none. */
export const parseSkillFrontmatter = (
  markdown: string,
): { readonly name: string; readonly description: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const fields = new Map<string, string>();
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (pair) fields.set(pair[1]!.toLowerCase(), unquote(pair[2]!.trim()));
  }
  return { name: fields.get("name") ?? "", description: fields.get("description") ?? "" };
};

const unquote = (value: string) => (/^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value);

/** A path inside a skill folder: relative, no `..`, no hidden parts, nothing exotic. */
export const isSafeSkillPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 200 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".")) &&
  /^[\w./@+ -]+$/.test(path);

/** Whether `latest` (the folder's tree SHA upstream now) differs from what is pinned. */
export const updateStatusOf = (skill: Skill, latestSha: string | null): SkillUpdateStatus => ({
  skillId: skill.id,
  state: latestSha === null ? "missing" : latestSha === skill.sha ? "current" : "update_available",
  latestSha,
});

/** The skill set a classified request is routed to; null when none fits or Jev is unsure. */
export const chosenSkillSet = (result: {
  readonly skillSet?: { readonly choice: string; readonly confidence: number };
}): string | null =>
  result.skillSet &&
  result.skillSet.choice !== NO_SKILL_SET &&
  result.skillSet.confidence >= SKILL_SET_MIN_CONFIDENCE
    ? result.skillSet.choice
    : null;
