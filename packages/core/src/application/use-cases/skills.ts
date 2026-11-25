import type { SkillCandidates, SkillUpdateReport, Ticket } from "@project-os/contracts";
import { Effect } from "effect";
import {
  InvalidTaskType,
  InvalidSkillSource,
  mergeSkillArchives,
  NO_TASK_TYPE,
  packSkill,
  SkillFetchFailed,
  skillArchiveKey,
  parseSkillFrontmatter,
  parseSkillSource,
  SkillNotFound,
  updateStatusOf,
  type Skill,
  type TaskType,
} from "../../domain/index.ts";
import {
  AssetStore,
  IdGenerator,
  SkillRepository,
  SkillSource,
  TicketRepository,
} from "../ports/index.ts";
import { guardTicketAccess, type McpCaller } from "./personal-workers.ts";
import { nowIso } from "./tickets.ts";

const cleanName = (name: string) =>
  Effect.gen(function* () {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 60) {
      return yield* new InvalidTaskType({ message: "A set's name is 1 to 60 characters." });
    }
    if (trimmed.toLowerCase() === NO_TASK_TYPE) {
      return yield* new InvalidTaskType({ message: `"${NO_TASK_TYPE}" is reserved.` });
    }
    return trimmed;
  });

/** Every set with its skills, by name. */
export const listTaskTypes = Effect.gen(function* () {
  const repo = yield* SkillRepository;
  const sets = [...(yield* repo.listSets)].sort((a, b) => a.name.localeCompare(b.name));
  return {
    sets: yield* Effect.forEach(sets, (set) =>
      Effect.map(repo.listSkills(set.id), (skills) => ({ set, skills })),
    ),
  };
});

export const getTaskType = (id: string) =>
  Effect.gen(function* () {
    const repo = yield* SkillRepository;
    const set = yield* repo.getSet(id);
    return { set, skills: yield* repo.listSkills(id) };
  });

export const createTaskType = (input: {
  readonly name: string;
  readonly description: string;
  readonly instructions?: string;
}) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    const set: TaskType = {
      id: yield* (yield* IdGenerator).next,
      name: yield* cleanName(input.name),
      description: input.description.trim(),
      instructions: (input.instructions ?? "").trim(),
      createdAt: at,
      updatedAt: at,
    };
    return yield* (yield* SkillRepository).insertSet(set);
  });

export const updateTaskType = (
  id: string,
  patch: { readonly name?: string; readonly description?: string; readonly instructions?: string },
) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    return yield* (yield* SkillRepository).updateSet(id, {
      ...(patch.name !== undefined && { name: yield* cleanName(patch.name) }),
      ...(patch.description !== undefined && { description: patch.description.trim() }),
      ...(patch.instructions !== undefined && { instructions: patch.instructions.trim() }),
      updatedAt: at,
    });
  });

export const deleteTaskType = (id: string) =>
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

/** Most a skill's zip may weigh: its files are capped at 1 MB, zipping only shrinks them. */
const ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;

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
    const archiveKey = skillArchiveKey({ taskTypeId: setId, id, sha });
    const zip = packSkill(candidate.slug, files);
    yield* (yield* AssetStore)
      .put({
        key: archiveKey,
        body: new Blob([zip]).stream(),
        contentType: "application/zip",
        size: zip.byteLength,
        maxBytes: ARCHIVE_MAX_BYTES,
      })
      .pipe(
        Effect.mapError(
          (e) => new SkillFetchFailed({ message: `Could not store the skill: ${e.message}` }),
        ),
      );
    return yield* repo.upsertSkill({
      id,
      archiveKey,
      taskTypeId: setId,
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
    });
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
 * The skills a Worker is given before it starts its ticket: one zip of the pinned skills of the
 * ticket's task type, entries `<slug>/<path>`. Only the ticket's own worker may read it. A ticket
 * with no set (or whose set was deleted or has no skills) gets `archive: null`.
 */
export const skillArchiveForTicket = (ticketId: string, caller: McpCaller) =>
  Effect.gen(function* () {
    yield* guardTicketAccess(ticketId, caller);
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    const repo = yield* SkillRepository;
    const set = ticket.taskTypeId
      ? yield* repo.getSet(ticket.taskTypeId).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    const skills = set ? yield* repo.listSkills(set.id) : [];
    if (!set || skills.length === 0) return { set: null, archive: null };
    const assets = yield* AssetStore;
    const archives = yield* Effect.forEach(skills, (skill) =>
      Effect.gen(function* () {
        const object = yield* assets
          .get(skill.archiveKey)
          .pipe(Effect.mapError((e) => new SkillFetchFailed({ message: e.message })));
        if (!object) {
          return yield* new SkillFetchFailed({
            message: `The stored copy of ${skill.name} is missing; update the skill.`,
          });
        }
        return new Uint8Array(yield* Effect.promise(() => new Response(object.body).arrayBuffer()));
      }),
    );
    return { set: { id: set.id, name: set.name }, archive: mergeSkillArchives(archives) };
  });

/** The sets Jev may route a new request to: those with at least one skill. */
export const taskTypeChoices = Effect.gen(function* () {
  const repo = yield* SkillRepository;
  const sets = yield* repo.listSets;
  const withSkills = yield* Effect.filter(sets, (set) =>
    Effect.map(repo.listSkills(set.id), (skills) => skills.length > 0),
  );
  return withSkills.map(({ id, name, description }) => ({ id, name, description }));
});

export const taskTypeOf = (taskTypeId: string | null | undefined) =>
  taskTypeId
    ? Effect.flatMap(SkillRepository, (repo) =>
        repo.getSet(taskTypeId).pipe(Effect.orElseSucceed(() => undefined)),
      )
    : Effect.succeed(undefined);

/** A ticket detail plus the name of the task type it was routed to; null when none, or deleted since. */
export const withTaskType = <T extends { readonly ticket: Ticket }>(detail: T) =>
  Effect.map(taskTypeOf(detail.ticket.taskTypeId), (type) => ({
    ...detail,
    taskType: type ? { id: type.id, name: type.name } : null,
  }));

/**
 * The task type a Worker's session runs under, with the instructions that go into its system
 * prompt. Only the ticket's own worker may read it; null when the ticket has no task type.
 */
export const taskTypeForTicket = (ticketId: string, caller: McpCaller) =>
  Effect.gen(function* () {
    yield* guardTicketAccess(ticketId, caller);
    const ticket = yield* (yield* TicketRepository).get(ticketId);
    const type = yield* taskTypeOf(ticket.taskTypeId);
    return type ? { id: type.id, name: type.name, instructions: type.instructions } : null;
  });
