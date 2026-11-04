import {
  MemoryRepository,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
  WorkerRepository,
} from "@project-os/core";
import { Layer } from "effect";
import type { SqliteDb } from "./db.ts";
import { makeMemoryRepository } from "./memory.ts";
import { makeProjectRepository } from "./project.ts";
import { makeProjectSourceRepository } from "./project-source.ts";
import { makeTicketRepository } from "./ticket.ts";
import { makeWorkerRepository } from "./worker.ts";

export type { SqliteDb } from "./db.ts";

/** All repository ports backed by any Drizzle SQLite db (D1 or `bun:sqlite`). */
export const SqliteRepositories = (db: SqliteDb) =>
  Layer.mergeAll(
    Layer.succeed(TicketRepository, makeTicketRepository(db)),
    Layer.succeed(ProjectRepository, makeProjectRepository(db)),
    Layer.succeed(ProjectSourceRepository, makeProjectSourceRepository(db)),
    Layer.succeed(MemoryRepository, makeMemoryRepository(db)),
    Layer.succeed(WorkerRepository, makeWorkerRepository(db)),
  );
