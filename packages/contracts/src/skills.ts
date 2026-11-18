import { Schema } from "effect";

const Id = Schema.NonEmptyString;

/** One file of a skill, `path` relative to the skill's folder (always `SKILL.md` at least). */
export const SkillFile = Schema.Struct({ path: Schema.String, contents: Schema.String });
export type SkillFile = typeof SkillFile.Type;

/** A named group of skills a Ticket can be routed to, e.g. "development". */
export const SkillSet = Schema.Struct({
  id: Id,
  name: Schema.NonEmptyString,
  /** What the set is for; Jev picks a set from this, so say which requests belong to it. */
  description: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type SkillSet = typeof SkillSet.Type;

/** A skill pinned in a set: one folder of a GitHub repo, at the commit that was downloaded. */
export const Skill = Schema.Struct({
  id: Id,
  skillSetId: Id,
  /** `owner/repo` on GitHub, as skills.sh lists it. */
  source: Schema.String,
  /** Folder name of the skill; with `source` it is the skills.sh id `owner/repo/slug`. */
  slug: Schema.String,
  /** From the `name` in SKILL.md's frontmatter (the slug when it has none). */
  name: Schema.String,
  description: Schema.String,
  /** Folder of the skill inside the repo. */
  path: Schema.String,
  /** Git tree SHA of that folder: it changes exactly when a file in it changes. */
  sha: Schema.String,
  fileCount: Schema.Finite,
  bytes: Schema.Finite,
  fetchedAt: Schema.String,
  fetchedBy: Schema.NullOr(Schema.String),
});
export type Skill = typeof Skill.Type;

export const SkillSetDetail = Schema.Struct({
  set: SkillSet,
  skills: Schema.Array(Skill),
});
export type SkillSetDetail = typeof SkillSetDetail.Type;

export const SkillSetList = Schema.Struct({
  sets: Schema.Array(SkillSetDetail),
});
export type SkillSetList = typeof SkillSetList.Type;

/** A skill found in a repo, not yet added to a set. */
export const SkillCandidate = Schema.Struct({
  source: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
});
export type SkillCandidate = typeof SkillCandidate.Type;

export const SkillCandidates = Schema.Struct({
  source: Schema.String,
  skills: Schema.Array(SkillCandidate),
});
export type SkillCandidates = typeof SkillCandidates.Type;

/** What upstream says about a pinned skill. */
export const SkillUpdateState = Schema.Literals(["current", "update_available", "missing"]);
export type SkillUpdateState = typeof SkillUpdateState.Type;

export const SkillUpdateStatus = Schema.Struct({
  skillId: Id,
  state: SkillUpdateState,
  /** The folder's tree SHA upstream now; null when it is gone. */
  latestSha: Schema.NullOr(Schema.String),
});
export type SkillUpdateStatus = typeof SkillUpdateStatus.Type;

export const SkillUpdateReport = Schema.Struct({ statuses: Schema.Array(SkillUpdateStatus) });
export type SkillUpdateReport = typeof SkillUpdateReport.Type;

/** What a Worker is given before it starts: the skill folders of its ticket's set. */
export const SkillBundle = Schema.Struct({
  set: Schema.NullOr(Schema.Struct({ id: Id, name: Schema.String })),
  skills: Schema.Array(
    Schema.Struct({ slug: Schema.String, name: Schema.String, files: Schema.Array(SkillFile) }),
  ),
});
export type SkillBundle = typeof SkillBundle.Type;

/** Where a skill folder's files go: `<root>/<slug>/<path>`. Slugs and paths never escape it. */
export const SAFE_SKILL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
