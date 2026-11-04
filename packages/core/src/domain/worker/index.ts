import type { WorkerType } from "@project-os/contracts";
import { Data } from "effect";

export type { WorkerType };

export type WorkerStatus = "online" | "offline";

export interface Worker {
  readonly id: string;
  readonly workerType: WorkerType;
  readonly currentTicketId: string | null;
  readonly lastSeenAt: string;
  readonly createdAt: string;
}

export class WorkerNotFound extends Data.TaggedError("WorkerNotFound")<{
  readonly workerId: string;
}> {}

/** Online/offline is derived from `lastSeenAt`, never stored. */
export const workerStatus = (worker: Worker, now: Date, staleAfterMs: number): WorkerStatus =>
  now.getTime() - Date.parse(worker.lastSeenAt) <= staleAfterMs ? "online" : "offline";
