import type { SkillBundle, SkillCandidates, SkillUpdateReport } from "@project-os/contracts";
import { Effect } from "effect";
import {
  InvalidSkillSet,
  InvalidSkillSource,
  NO_SKILL_SET,
  parseSkillFrontmatter,
  parseSkillSource,
  SkillNotFound,
  updateStatusOf,
  type Skill,
  type SkillSet,
} from "../../domain/index.ts";
import { IdGenerator, SkillRepository, SkillSource, TicketRepository } from "../ports/index.ts";
import { guardTicketAccess, type McpCaller } from "./personal-workers.ts";
import { nowIso } from "./tickets.ts";

const cleanName = (name: string) =>
  Effect.gen(function* () {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 60) {
      return yield* new InvalidSkillSet({ message: "A set's name is 1 to 60 characters." });
    }
    if (trimmed.toLowerCase() === NO_SKILL_SET) {
      return yield* new InvalidSkillSet({ message: `"${NO_SKILL_SET}" is reserved.` });
    }
    return trimmed;
  });

/** Every set with its skills, by name. */
export const listSkillSets = Effect.gen(function* () {
  const repo = yield* SkillRepository;
  const sets = [...(yield* repo.listSets)].sort((a, b) => a.name.localeCompare(b.name));
  return {
    sets: yield* Effect.forEach(sets, (set) =>
      Effect.map(repo.listSkills(set.id), (skills) => ({ set, skills })),
    ),
  };
});

export const getSkillSet = (id: string) =>
  Effect.gen(function* () {
    const repo = yield* SkillRepository;
    const set = yield* repo.getSet(id);
    return { set, skills: yield* repo.listSkills(id) };
  });

export const createSkillSet = (input: { readonly name: string; readonly description: string }) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    const set: SkillSet = {
      id: yield* (yield* IdGenerator).next,
      name: yield* cleanName(input.name),
      description: input.description.trim(),
      createdAt: at,
      updatedAt: at,
    };
    return yield* (yield* SkillRepository).insertSet(set);
  });

export const updateSkillSet = (
  id: string,
  patch: { readonly name?: string; readonly description?: string },
) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    return yield* (yield* SkillRepository).updateSet(id, {
      ...(patch.name !== undefined && { name: yield* cleanName(patch.name) }),
      ...(patch.description !== undefined && { description: patch.description.trim() }),
      updatedAt: at,
    });
  });

export const deleteSkillSet = (id: string) =>
  Effect.flatMap(SkillRepository, (repo) => repo.deleteSet(id));

export const removeSkillFromSet = (skillId: string) =>
  Effect.flatMap(SkillRepository, (repo) => repo.removeSkill(skillId));

const sourceOf = (input: string) => {
  const ref = parseSkillSource(input);
  return ref
    ? Effect.succeed(ref)
    : Effect.fail(
        new InvalidSkillSource({
          message: "Use owner/repo, or a skills.sh or github.com link to a repo.",
        }),
      );
};

/** The skills in a repo an Operator pasted, for them to pick from. Nothing is stored. */
export const browseSkillSource = (input: string) =>
  Effect.gen(function* () {
    const ref = yield* sourceOf(input);
    const found = yield* (yield* SkillSource).list(ref.source);
    return {
      source: ref.source,
      skills: ref.slug ? found.filter((s) => s.slug === ref.slug) : found,
    } satisfies SkillCandidates;
  });

/**
 * Downloads the named skills of `source` and pins them in the set (a skill already there is
 * replaced by the fresh copy). `by` is who clicked, for the skill's record.
 */
export const addSkillsToSet = (input: {
  readonly setId: string;
  readonly source: string;
  readonly slugs: ReadonlyArray<string>;
  readonly by: string | null;
}) =>
  Effect.gen(function* () {
    const repo = yield* SkillRepository;
    yield* repo.getSet(input.setId);
    const ref = yield* sourceOf(input.source);
    const upstream = yield* SkillSource;
    const candidates = yield* upstream.list(ref.source);
    const added: Skill[] = [];
    for (const slug of input.slugs) {
      const candidate = candidates.find((c) => c.slug === slug);
      if (!candidate) {
        return yield* new InvalidSkillSource({ message: `${ref.source} has no skill "${slug}".` });
      }
      added.push(yield* download(repo, upstream, input.setId, candidate, input.by, undefined));
    }
    return added;
  });

const download = (
  repo: typeof SkillRepository.Service,
  upstream: typeof SkillSource.Service,
  setId: string,
  candidate: { readonly source: string; readonly slug: string; readonly path: string },
  by: string | null,
  existing: Skill | undefined,
) =>
  Effect.gen(function* () {
    const { sha, files } = yield* upstream.fetch(candidate.source, candidate.path);
    const meta = parseSkillFrontmatter(files.find((f) => f.path === "SKILL.md")?.contents ?? "");
    const id = existing?.id ?? (yield* (yield* IdGenerator).next);
    return yield* repo.upsertSkill(
      {
        id,
        skillSetId: setId,
        source: candidate.source,
        slug: candidate.slug,
        name: meta.name || candidate.slug,
        description: meta.description,
        path: candidate.path,
        sha,
        fileCount: files.length,
        bytes: files.reduce((total, f) => total + new TextEncoder().encode(f.contents).length, 0),
        fetchedAt: yield* nowIso,
        fetchedBy: by,
      },
      files,
    );
  });

/** Asks upstream whether each skill of the set has changed since it was pinned. */
export const checkSkillUpdates = (setId: string) =>
  Effect.gen(function* () {
    const repo = yield* SkillRepository;
    const upstream = yield* SkillSource;
    yield* repo.getSet(setId);
    const skills = yield* repo.listSkills(setId);
    const statuses = yield* Effect.forEach(skills, (skill) =>
      Effect.map(upstream.latestSha(skill.source, skill.path), (sha) => updateStatusOf(skill, sha)),
    );
    return { statuses } satisfies SkillUpdateReport;
  });

/**
 * Fetches the newer version of the set's skills that changed upstream (all of them, or just
 * `skillIds`). A skill that is current is left alone; one that is gone upstream stays pinned.
 * Returns the skills that were replaced.
 */
export const updateSkillsInSet = (input: {
  readonly setId: string;
  readonly skillIds?: ReadonlyArray<string>;
  readonly by: string | null;
}) =>
  Effect.gen(function* () {
    const repo = yield* SkillRepository;
    const upstream = yield* SkillSource;
    yield* repo.getSet(input.setId);
    const inSet = yield* repo.listSkills(input.setId);
    const wanted = input.skillIds;
    if (wanted) {
      const missing = wanted.find((id) => !inSet.some((s) => s.id === id));
      if (missing !== undefined) return yield* new SkillNotFound({ skillId: missing });
    }
    const updated: Skill[] = [];
    for (const skill of inSet.filter((s) => !wanted || wanted.includes(s.id))) {
      const latest = yield* upstream.latestSha(skill.source, skill.path);
      if (updateStatusOf(skill, latest).state !== "update_available") continue;
      updated.push(yield* download(repo, upstream, input.setId, skill, input.by, skill));
    }
    return updated;
  });

/**
 * The skills a Worker is given before it starts its ticket: the pinned files of the ticket's
 * skill set. Only the ticket's own worker may read them. A ticket with no set (or whose set was
 * deleted) gets an empty bundle.
 */
export const skillBundleForTicket = (ticketId: string, caller: McpCaller) =>
  Effect.gen(function* () {
    yield* guardTicketAccess(ticketId, caller);
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    const repo = yield* SkillRepository;
    const set = ticket.skillSetId
      ? yield* repo.getSet(ticket.skillSetId).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    if (!set) return { set: null, skills: [] } satisfies SkillBundle;
    return {
      set: { id: set.id, name: set.name },
      skills: yield* repo.filesOfSet(set.id),
    } satisfies SkillBundle;
  });

/** The sets Jev may route a new request to: those with at least one skill. */
export const skillSetChoices = Effect.gen(function* () {
  const repo = yield* SkillRepository;
  const sets = yield* repo.listSets;
  const withSkills = yield* Effect.filter(sets, (set) =>
    Effect.map(repo.listSkills(set.id), (skills) => skills.length > 0),
  );
  return withSkills.map(({ id, name, description }) => ({ id, name, description }));
});
