import {
  SkillNotFound,
  SkillSetNameTaken,
  SkillSetNotFound,
  type Skill,
  type SkillRepository,
  type SkillSet,
} from "@project-os/core";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { skills, skillSets } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof SkillRepository)["Service"];

/** A skill row without its files: what lists and the dashboard get. */
const summary = (row: typeof skills.$inferSelect): Skill => ({
  id: row.id,
  skillSetId: row.skillSetId,
  source: row.source,
  slug: row.slug,
  name: row.name,
  description: row.description,
  path: row.path,
  sha: row.sha,
  fileCount: row.fileCount,
  bytes: row.bytes,
  fetchedAt: row.fetchedAt,
  fetchedBy: row.fetchedBy,
});

export const makeSkillRepository = (db: SqliteDb): Impl => {
  const findSet = (id: string): Effect.Effect<SkillSet, SkillSetNotFound> =>
    q(() => db.select().from(skillSets).where(eq(skillSets.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new SkillSetNotFound({ skillSetId: id })),
      ),
    );

  const nameTaken = (name: string, exceptId: string) =>
    q(() => db.select().from(skillSets).where(eq(skillSets.name, name))).pipe(
      Effect.map((rows) => rows.some((r) => r.id !== exceptId)),
    );

  return {
    listSets: q(() => db.select().from(skillSets)),
    getSet: findSet,
    insertSet: (set) =>
      nameTaken(set.name, set.id).pipe(
        Effect.flatMap((taken) =>
          taken
            ? Effect.fail(new SkillSetNameTaken({ setName: set.name }))
            : q(() => db.insert(skillSets).values(set).returning()).pipe(
                Effect.map(([row]) => row!),
              ),
        ),
      ),
    updateSet: (id, patch) =>
      Effect.gen(function* () {
        yield* findSet(id);
        if (patch.name !== undefined && (yield* nameTaken(patch.name, id))) {
          return yield* new SkillSetNameTaken({ setName: patch.name });
        }
        const [row] = yield* q(() =>
          db.update(skillSets).set(patch).where(eq(skillSets.id, id)).returning(),
        );
        return row!;
      }),
    deleteSet: (id) =>
      findSet(id).pipe(
        Effect.flatMap(() => q(() => db.delete(skills).where(eq(skills.skillSetId, id)))),
        Effect.flatMap(() => q(() => db.delete(skillSets).where(eq(skillSets.id, id)))),
        Effect.asVoid,
      ),
    listSkills: (setId) =>
      q(() => db.select().from(skills).where(eq(skills.skillSetId, setId))).pipe(
        Effect.map((rows) => rows.map(summary).sort((a, b) => a.name.localeCompare(b.name))),
      ),
    getSkill: (id) =>
      q(() => db.select().from(skills).where(eq(skills.id, id)).limit(1)).pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(summary(row)) : Effect.fail(new SkillNotFound({ skillId: id })),
        ),
      ),
    upsertSkill: (skill, files) =>
      q(() =>
        db
          .select({ id: skills.id })
          .from(skills)
          .where(
            and(
              eq(skills.skillSetId, skill.skillSetId),
              eq(skills.source, skill.source),
              eq(skills.slug, skill.slug),
            ),
          )
          .limit(1),
      ).pipe(
        Effect.flatMap(([existing]) => {
          const id = existing?.id ?? skill.id;
          const values = { ...skill, id, files };
          return q(() =>
            db
              .insert(skills)
              .values(values)
              .onConflictDoUpdate({ target: skills.id, set: values })
              .returning(),
          );
        }),
        Effect.map(([row]) => summary(row!)),
      ),
    removeSkill: (id) =>
      q(() => db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id })).pipe(
        Effect.flatMap((rows) =>
          rows.length > 0 ? Effect.void : Effect.fail(new SkillNotFound({ skillId: id })),
        ),
      ),
    filesOfSet: (setId) =>
      q(() => db.select().from(skills).where(eq(skills.skillSetId, setId))).pipe(
        Effect.map((rows) =>
          rows
            .map((r) => ({ slug: r.slug, name: r.name, files: r.files }))
            .sort((a, b) => a.slug.localeCompare(b.slug)),
        ),
      ),
  };
};
