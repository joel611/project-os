import type { Project } from "@project-os/contracts";
import { Data } from "effect";

export type { Project };

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  readonly projectId: string;
}> {}

export const isActive = (project: Project): boolean => project.status === "active";
