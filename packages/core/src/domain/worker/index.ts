import type { Worker, WorkerStatus, WorkerType } from "@project-os/contracts";
import { Data } from "effect";

export type { Worker, WorkerStatus, WorkerType };

export class WorkerNotFound extends Data.TaggedError("WorkerNotFound")<{
  readonly workerId: string;
}> {}

/** Online/offline is derived from `lastSeenAt`, never stored. */
export const workerStatus = (worker: Worker, now: Date, staleAfterMs: number): WorkerStatus =>
  now.getTime() - Date.parse(worker.lastSeenAt) <= staleAfterMs ? "online" : "offline";

/** A personal worker: a device someone registered, serving only their tickets. */
export const isPersonal = (worker: Worker): boolean => worker.ownerId !== null;

export const ownedBy = (
  worker: Worker,
  person: { readonly channelType: string; readonly id: string },
): boolean => worker.ownerChannelType === person.channelType && worker.ownerId === person.id;

/** The /register-worker code is unknown, expired, or already used. */
export class RegistrationInvalid extends Data.TaggedError("RegistrationInvalid")<{
  readonly message: string;
}> {}

/**
 * A caller tried to act as, or on the tickets of, a personal worker it isn't (or a personal
 * worker reached past its own tickets). Personal workers must present their bearer secret.
 */
export class WorkerUnauthorized extends Data.TaggedError("WorkerUnauthorized")<{
  readonly workerId: string;
  readonly message: string;
}> {}
