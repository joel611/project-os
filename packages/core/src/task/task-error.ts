import * as Data from "effect/Data";

export class TaskError extends Data.TaggedError("TaskError")<{
  readonly cause: unknown;
}> {}
