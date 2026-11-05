import type { Worker, WorkerStatus, WorkerType } from "@project-os/contracts";
import { Data } from "effect";

export type { Worker, WorkerStatus, WorkerType };

export class WorkerNotFound extends Data.TaggedError("WorkerNotFound")<{
  readonly workerId: string;
}> {}

/** Online/offline is derived from `lastSeenAt`, never stored. */
export const workerStatus = (worker: Worker, now: Date, staleAfterMs: number): WorkerStatus =>
  now.getTime() - Date.parse(worker.lastSeenAt) <= staleAfterMs ? "online" : "offline";
