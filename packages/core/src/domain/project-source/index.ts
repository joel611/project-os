import type { ProjectSource, ProjectSourceType, SourceDirection } from "@project-os/contracts";
import { Data } from "effect";

export type { ProjectSource, ProjectSourceType, SourceDirection };

/** `(type, externalId)` is already linked to a project. Enforces the 1:1 channel → project rule. */
export class SourceAlreadyLinked extends Data.TaggedError("SourceAlreadyLinked")<{
  readonly type: ProjectSourceType;
  readonly externalId: string;
  readonly projectId: string;
}> {}

export class SourceNotFound extends Data.TaggedError("SourceNotFound")<{
  readonly sourceId: string;
}> {}

export const isInbound = (s: ProjectSource): boolean =>
  s.status === "active" && s.direction !== "outbound";
