import {
  SourceAlreadyLinked,
  SourceNotFound,
  type ProjectSource,
  type ProjectSourceRepository,
  type ProjectSourceType,
} from "@project-os/core";
import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import { projectSources } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof ProjectSourceRepository)["Service"];

export const makeProjectSourceRepository = (db: SqliteDb): Impl => {
  const findByExternal = (type: ProjectSourceType, externalId: string) =>
    q(() =>
      db
        .select()
        .from(projectSources)
        .where(and(eq(projectSources.type, type), eq(projectSources.externalId, externalId)))
        .limit(1),
    ).pipe(Effect.map(([row]): ProjectSource | undefined => row));

  return {
    insert: (source) =>
      q(() =>
        db
          .insert(projectSources)
          .values(source)
          .onConflictDoNothing({ target: [projectSources.type, projectSources.externalId] })
          .returning(),
      ).pipe(
        Effect.flatMap(([inserted]) =>
          inserted
            ? Effect.succeed(inserted)
            : findByExternal(source.type, source.externalId).pipe(
                Effect.flatMap((existing) =>
                  Effect.fail(
                    new SourceAlreadyLinked({
                      type: source.type,
                      externalId: source.externalId,
                      projectId: existing!.projectId,
                    }),
                  ),
                ),
              ),
        ),
      ),
    findByExternal,
    listByProject: (projectId) =>
      q(() => db.select().from(projectSources).where(eq(projectSources.projectId, projectId))),
    setDefaultResponse: (projectId, sourceId) =>
      q(() =>
        db
          .select({ id: projectSources.id })
          .from(projectSources)
          .where(and(eq(projectSources.id, sourceId), eq(projectSources.projectId, projectId)))
          .limit(1),
      ).pipe(
        Effect.flatMap(([found]) =>
          found ? Effect.void : Effect.fail(new SourceNotFound({ sourceId })),
        ),
        // Clear first: the partial unique index forbids two defaults, even transiently.
        Effect.andThen(
          q(() =>
            db
              .update(projectSources)
              .set({ isDefaultResponse: false })
              .where(and(eq(projectSources.projectId, projectId), ne(projectSources.id, sourceId))),
          ),
        ),
        Effect.andThen(
          q(() =>
            db
              .update(projectSources)
              .set({ isDefaultResponse: true })
              .where(eq(projectSources.id, sourceId))
              .returning(),
          ),
        ),
        Effect.map(([row]) => row!),
      ),
  };
};
