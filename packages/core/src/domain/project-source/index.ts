import type { ProjectSourceType } from "@project-os/contracts";
import { Data } from "effect";

export type { ProjectSourceType };

export type SourceDirection = "inbound" | "outbound" | "both";
export type SourceStatus = "active" | "disabled";

export interface ProjectSource {
  readonly id: string;
  readonly projectId: string;
  readonly type: ProjectSourceType;
  readonly externalId: string;
  readonly name: string;
  readonly direction: SourceDirection;
  readonly isDefaultResponse: boolean;
  readonly config: unknown;
  readonly status: SourceStatus;
  readonly connectedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
