import {
  AuditLogRepository,
  ChannelMessageRepository,
  MemoryRepository,
  ProjectRepository,
  ProjectSourceRepository,
  SkillRepository,
  TicketRepository,
  WorkerRepository,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import { DrizzleSqlite } from "./db.ts";
import { makeChannelMessageRepository } from "./channel-message.ts";
import { makeAuditLogRepository } from "./audit-log.ts";
import { makeMemoryRepository } from "./memory.ts";
import { makeProjectRepository } from "./project.ts";
import { makeProjectSourceRepository } from "./project-source.ts";
import { makeSkillRepository } from "./skill.ts";
import { makeTicketRepository } from "./ticket.ts";
import { makeWorkerRepository } from "./worker.ts";

export { DrizzleSqlite, type SqliteDb } from "./db.ts";

/** All repository ports over the `DrizzleSqlite` in scope (D1 or `bun:sqlite`). */
export const SqliteRepositories = Layer.unwrap(
  Effect.map(Effect.service(DrizzleSqlite), (db) =>
    Layer.mergeAll(
      Layer.succeed(TicketRepository, makeTicketRepository(db)),
      Layer.succeed(ProjectRepository, makeProjectRepository(db)),
      Layer.succeed(ProjectSourceRepository, makeProjectSourceRepository(db)),
      Layer.succeed(MemoryRepository, makeMemoryRepository(db)),
      Layer.succeed(WorkerRepository, makeWorkerRepository(db)),
      Layer.succeed(ChannelMessageRepository, makeChannelMessageRepository(db)),
      Layer.succeed(AuditLogRepository, makeAuditLogRepository(db)),
      Layer.succeed(SkillRepository, makeSkillRepository(db)),
    ),
  ),
);
