import type { MemoryEntryType } from "@project-os/contracts";
import { Effect } from "effect";
import { IdGenerator, MemoryRepository, WorkerRepository } from "../ports/index.ts";
import { nowIso } from "./tickets.ts";

export const readMemory = (input: {
  readonly projectId: string;
  readonly type?: MemoryEntryType;
  readonly limit?: number;
}) =>
  Effect.gen(function* () {
    const repo = yield* MemoryRepository;
    const { projectId, ...options } = input;
    return yield* repo.list(projectId, options);
  });

/**
 * Appends a memory entry. `ticketId` is auto-linked: an explicit value wins, otherwise the
 * writing worker's current ticket (when `workerId` is given and known).
 */
export const writeMemory = (input: {
  readonly projectId: string;
  readonly ticketId?: string;
  readonly workerId?: string;
  readonly type: MemoryEntryType;
  readonly title: string;
  readonly content: string;
  readonly sourceMetadata?: unknown;
}) =>
  Effect.gen(function* () {
    const memory = yield* MemoryRepository;
    const workers = yield* WorkerRepository;
    const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    const createdAt = yield* nowIso;
    let ticketId = input.ticketId ?? null;
    if (ticketId === null && input.workerId !== undefined) {
      ticketId = yield* workers.get(input.workerId).pipe(
        Effect.map((w) => w.currentTicketId),
        Effect.catchTag("WorkerNotFound", () => Effect.succeed(null)),
      );
    }
    return yield* memory.insert({
      id,
      projectId: input.projectId,
      ticketId,
      type: input.type,
      title: input.title,
      content: input.content,
      sourceMetadata: input.sourceMetadata ?? null,
      createdBy: input.workerId ?? null,
      createdAt,
    });
  });
