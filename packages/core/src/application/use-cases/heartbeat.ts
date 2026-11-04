import type { WorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { WorkerRepository } from "../ports/index.ts";
import { nowIso } from "./tickets.ts";

/** Upserts the Worker and stamps `lastSeenAt`. */
export const heartbeat = (input: {
  readonly workerId: string;
  readonly workerType: WorkerType;
  readonly ticketId?: string;
}) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const at = yield* nowIso;
    return yield* workers.heartbeat({
      workerId: input.workerId,
      workerType: input.workerType,
      ticketId: input.ticketId ?? null,
      at,
    });
  });
