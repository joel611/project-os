import { SANDBOX_PROVIDER_OF, type SandboxWorkerType } from "@project-os/contracts";
import { Effect } from "effect";
import { ACTIVE_STATUSES } from "../../domain/index.ts";
import { type SandboxPoolEntry, TicketRepository, WorkerLauncher } from "../ports/index.ts";

/**
 * The worker id a sandbox session claims as: one fresh worker per ticket, `<provider>-<id>`
 * with the provider name, e.g. `daytona-<id>`.
 */
export const sandboxWorkerId = (workerType: SandboxWorkerType, ticketId: string) =>
  `${SANDBOX_PROVIDER_OF[workerType]}-${ticketId}`;

/**
 * Reads the sandbox pool and returns the first provider, in pool order, with room for one more
 * active ticket. Undefined when the pool is empty or every provider is at its cap.
 */
export const pickSandboxProvider = Effect.gen(function* () {
  const pool = yield* (yield* WorkerLauncher).pool;
  if (pool.length === 0) return undefined;
  const capped = pool.some((entry) => entry.maxConcurrent !== undefined);
  const active = capped ? yield* (yield* TicketRepository).listByStatus(ACTIVE_STATUSES) : [];
  const load = (entry: SandboxPoolEntry) =>
    active.filter((t) => t.workerType === entry.workerType).length;
  return pool.find(
    (entry) => entry.maxConcurrent === undefined || load(entry) < entry.maxConcurrent,
  );
});
