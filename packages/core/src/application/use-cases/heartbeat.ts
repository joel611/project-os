import type { WorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { workerStatus } from "../../domain/index.ts";
import { WorkerRepository } from "../ports/index.ts";
import { auditWorker } from "./audit.ts";
import { DEFAULT_WORKER_STALE_MS } from "./placement.ts";
import { nowIso } from "./tickets.ts";

/**
 * Upserts the Worker and stamps `lastSeenAt`. Its first heartbeat, and the first one after it
 * went offline (silent for longer than `staleMs`), are logged to the audit log; the rest are not.
 */
export const heartbeat = (input: {
  readonly workerId: string;
  readonly workerType: WorkerType;
  readonly ticketId?: string;
  readonly staleMs?: number;
}) =>
  Effect.gen(function* () {
    const workers = yield* WorkerRepository;
    const at = yield* nowIso;
    const before = yield* workers
      .get(input.workerId)
      .pipe(Effect.catchTag("WorkerNotFound", () => Effect.undefined));
    const worker = yield* workers.heartbeat({
      workerId: input.workerId,
      workerType: input.workerType,
      ticketId: input.ticketId ?? null,
      at,
    });
    // A registered device starts with `lastSeenAt` at the epoch: not seen yet.
    if (before === undefined || Date.parse(before.lastSeenAt) <= 0) {
      yield* auditWorker(worker, "first_seen", { at });
    } else if (
      workerStatus(before, new Date(at), input.staleMs ?? DEFAULT_WORKER_STALE_MS) === "offline"
    ) {
      yield* auditWorker(worker, "back_online", { at });
    }
    return worker;
  });
