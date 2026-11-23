import type { Run, RunEvent, RunTranscript } from "@project-os/contracts";
import { Data } from "effect";

export type { Run, RunEvent, RunTranscript };

export class RunNotFound extends Data.TaggedError("RunNotFound")<{
  readonly runId: string;
}> {}

/** A chunk arrived out of order (`expected` is the one the Coordinator wants next). */
export class RunOutOfOrder extends Data.TaggedError("RunOutOfOrder")<{
  readonly runId: string;
  readonly expected: number;
}> {}

/** The run id is malformed, or already belongs to another ticket. */
export class RunRejected extends Data.TaggedError("RunRejected")<{
  readonly message: string;
}> {}

/** Where chunk `seq` of a run lives in file storage. */
export const runChunkKey = (ticketId: string, runId: string, seq: number): string =>
  `runs/${ticketId}/${runId}/${seq}.jsonl`;
