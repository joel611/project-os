import { WorkerNotFound, type WorkerRepository } from "@project-os/core";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { workers } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof WorkerRepository)["Service"];

export const makeWorkerRepository = (db: SqliteDb): Impl => ({
  heartbeat: ({ workerId, workerType, ticketId, at }) =>
    q(() =>
      db
        .insert(workers)
        .values({
          id: workerId,
          workerType,
          currentTicketId: ticketId,
          lastSeenAt: at,
          createdAt: at,
        })
        .onConflictDoUpdate({
          target: workers.id,
          set: { workerType, currentTicketId: ticketId, lastSeenAt: at },
        })
        .returning(),
    ).pipe(Effect.map(([row]) => row!)),
  get: (id) =>
    q(() => db.select().from(workers).where(eq(workers.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new WorkerNotFound({ workerId: id })),
      ),
    ),
  list: q(() => db.select().from(workers)),
});
