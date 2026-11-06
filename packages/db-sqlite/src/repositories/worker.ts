import { WorkerNotFound, type WorkerRepository } from "@project-os/core";
import type { Worker } from "@project-os/contracts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { workers } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof WorkerRepository)["Service"];
type Row = typeof workers.$inferSelect;

/** The secret hash stays in the database; nothing outside the repository sees it. */
const toWorker = (row: Row): Worker => ({
  id: row.id,
  workerType: row.workerType,
  ownerChannelType: row.ownerChannelType,
  ownerId: row.ownerId,
  name: row.name,
  currentTicketId: row.currentTicketId,
  lastSeenAt: row.lastSeenAt,
  createdAt: row.createdAt,
});

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
    ).pipe(Effect.map(([row]) => toWorker(row!))),
  get: (id) =>
    q(() => db.select().from(workers).where(eq(workers.id, id)).limit(1)).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(toWorker(row)) : Effect.fail(new WorkerNotFound({ workerId: id })),
      ),
    ),
  list: q(() => db.select().from(workers)).pipe(Effect.map((rows) => rows.map(toWorker))),
  register: ({ id, workerType, owner, name, secretHash, at }) =>
    q(() =>
      db
        .insert(workers)
        .values({
          id,
          workerType,
          ownerChannelType: owner.channelType,
          ownerId: owner.id,
          name,
          secretHash,
          currentTicketId: null,
          // Not seen yet: online only once its Watcher heartbeats.
          lastSeenAt: new Date(0).toISOString(),
          createdAt: at,
        })
        .returning(),
    ).pipe(Effect.map(([row]) => toWorker(row!))),
  findBySecretHash: (secretHash) =>
    q(() => db.select().from(workers).where(eq(workers.secretHash, secretHash)).limit(1)).pipe(
      Effect.map(([row]) => (row ? toWorker(row) : undefined)),
    ),
  listByOwner: (channelType, ownerId) =>
    q(() =>
      db
        .select()
        .from(workers)
        .where(and(eq(workers.ownerChannelType, channelType), eq(workers.ownerId, ownerId))),
    ).pipe(Effect.map((rows) => rows.map(toWorker))),
  remove: (id) =>
    q(() => db.delete(workers).where(eq(workers.id, id)).returning({ id: workers.id })).pipe(
      Effect.map((rows) => rows.length > 0),
    ),
});
