import { Data } from "effect";

export type ProjectStatus = "active" | "archived" | "deleted";

export interface Project {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string | null;
  readonly customInstructions: string;
  /** FK to a ProjectSource (usually Discord). */
  readonly defaultResponseChannelId: string | null;
  readonly status: ProjectStatus;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  readonly projectId: string;
}> {}

export const isActive = (project: Project): boolean => project.status === "active";
