import { Effect } from "effect";
import {
  SourceAlreadyLinked,
  type Project,
  type ProjectSource,
  type ProjectSourceType,
  type SourceDirection,
} from "../../domain/index.ts";
import { IdGenerator, ProjectRepository, ProjectSourceRepository } from "../ports/index.ts";
import { nowIso } from "./tickets.ts";

export const createProject = (input: {
  readonly orgId: string;
  readonly name: string;
  readonly slug?: string;
  readonly customInstructions?: string;
}) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    return yield* (yield* ProjectRepository).insert({
      id: yield* (yield* IdGenerator).next,
      orgId: input.orgId,
      name: input.name,
      slug: input.slug ?? null,
      customInstructions: input.customInstructions ?? "",
      defaultResponseChannelId: null,
      status: "active",
      createdBy: null,
      createdAt: at,
      updatedAt: at,
    } satisfies Project);
  });

export const addSource = (input: {
  readonly projectId: string;
  readonly type: ProjectSourceType;
  readonly externalId: string;
  readonly name: string;
  readonly direction?: SourceDirection;
  readonly isDefaultResponse?: boolean;
  readonly config?: unknown;
}) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(input.projectId);
    const sources = yield* ProjectSourceRepository;
    const at = yield* nowIso;
    const inserted = yield* sources.insert({
      id: yield* (yield* IdGenerator).next,
      projectId: input.projectId,
      type: input.type,
      externalId: input.externalId,
      name: input.name,
      direction: input.direction ?? "both",
      isDefaultResponse: false,
      config: input.config ?? null,
      status: "active",
      connectedBy: null,
      createdAt: at,
      updatedAt: at,
    } satisfies ProjectSource);
    // `setDefaultResponse` clears the flag on the project's other sources.
    return input.isDefaultResponse === true
      ? yield* sources.setDefaultResponse(input.projectId, inserted.id)
      : inserted;
  });

/**
 * Makes `externalId` the project's default reply channel. Links it first if it is new;
 * refuses a channel that already belongs to another project (1:1 channel → project).
 */
export const setDefaultChannel = (input: {
  readonly projectId: string;
  readonly externalId: string;
  readonly type?: ProjectSourceType;
}) =>
  Effect.gen(function* () {
    const type = input.type ?? "discord_channel";
    yield* (yield* ProjectRepository).get(input.projectId);
    const sources = yield* ProjectSourceRepository;
    const existing = yield* sources.findByExternal(type, input.externalId);
    if (!existing) {
      return yield* addSource({
        projectId: input.projectId,
        type,
        externalId: input.externalId,
        name: input.externalId,
        isDefaultResponse: true,
      });
    }
    if (existing.projectId !== input.projectId) {
      return yield* Effect.fail(
        new SourceAlreadyLinked({
          type,
          externalId: input.externalId,
          projectId: existing.projectId,
        }),
      );
    }
    return yield* sources.setDefaultResponse(input.projectId, existing.id);
  });
