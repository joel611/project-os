import { ProjectNotFound, type Project, type ProjectRepository } from "@project-os/core";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { projects } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof ProjectRepository)["Service"];

export const makeProjectRepository = (db: SqliteDb): Impl => ({
  insert: (project: Project) =>
    q(() => db.insert(projects).values(project)).pipe(Effect.as(project)),
  get: (id) =>
    q(() => db.select().from(projects).where(eq(projects.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new ProjectNotFound({ projectId: id })),
      ),
    ),
  list: q(() => db.select().from(projects)),
});
