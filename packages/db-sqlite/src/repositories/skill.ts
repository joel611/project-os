import {
  SkillNotFound,
  TaskTypeNameTaken,
  TaskTypeNotFound,
  type Skill,
  type SkillRepository,
  type TaskType,
} from "@project-os/core";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { skills, taskTypes } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof SkillRepository)["Service"];

/** A skill row without its files: what lists and the dashboard get. */
const summary = (row: typeof skills.$inferSelect): Skill => ({
  id: row.id,
  taskTypeId: row.taskTypeId,
  source: row.source,
  slug: row.slug,
  name: row.name,
  description: row.description,
  path: row.path,
  sha: row.sha,
  archiveKey: row.archiveKey,
  fileCount: row.fileCount,
  bytes: row.bytes,
  fetchedAt: row.fetchedAt,
  fetchedBy: row.fetchedBy,
});

export const makeSkillRepository = (db: SqliteDb): Impl => {
  const findSet = (id: string): Effect.Effect<TaskType, TaskTypeNotFound> =>
    q(() => db.select().from(taskTypes).where(eq(taskTypes.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new TaskTypeNotFound({ taskTypeId: id })),
      ),
    );

  const nameTaken = (name: string, exceptId: string) =>
    q(() => db.select().from(taskTypes).where(eq(taskTypes.name, name))).pipe(
      Effect.map((rows) => rows.some((r) => r.id !== exceptId)),
    );

  return {
    listSets: q(() => db.select().from(taskTypes)),
    getSet: findSet,
    insertSet: (set) =>
      nameTaken(set.name, set.id).pipe(
        Effect.flatMap((taken) =>
          taken
            ? Effect.fail(new TaskTypeNameTaken({ setName: set.name }))
            : q(() => db.insert(taskTypes).values(set).returning()).pipe(
                Effect.map(([row]) => row!),
              ),
        ),
      ),
    updateSet: (id, patch) =>
      Effect.gen(function* () {
        yield* findSet(id);
        if (patch.name !== undefined && (yield* nameTaken(patch.name, id))) {
          return yield* new TaskTypeNameTaken({ setName: patch.name });
        }
        const [row] = yield* q(() =>
          db.update(taskTypes).set(patch).where(eq(taskTypes.id, id)).returning(),
        );
        return row!;
      }),
    deleteSet: (id) =>
      findSet(id).pipe(
        Effect.flatMap(() => q(() => db.delete(skills).where(eq(skills.taskTypeId, id)))),
        Effect.flatMap(() => q(() => db.delete(taskTypes).where(eq(taskTypes.id, id)))),
        Effect.asVoid,
      ),
    listSkills: (setId) =>
      q(() => db.select().from(skills).where(eq(skills.taskTypeId, setId))).pipe(
        Effect.map((rows) => rows.map(summary).sort((a, b) => a.name.localeCompare(b.name))),
      ),
    getSkill: (id) =>
      q(() => db.select().from(skills).where(eq(skills.id, id)).limit(1)).pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(summary(row)) : Effect.fail(new SkillNotFound({ skillId: id })),
        ),
      ),
    upsertSkill: (skill) =>
      q(() =>
        db
          .select({ id: skills.id })
          .from(skills)
          .where(
            and(
              eq(skills.taskTypeId, skill.taskTypeId),
              eq(skills.source, skill.source),
              eq(skills.slug, skill.slug),
            ),
          )
          .limit(1),
      ).pipe(
        Effect.flatMap(([existing]) => {
          const id = existing?.id ?? skill.id;
          const values = { ...skill, id };
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
  };
};
