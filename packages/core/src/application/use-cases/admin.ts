import { Effect, Result } from "effect";
import {
  SourceAlreadyLinked,
  type Project,
  type ProjectSource,
  type ProjectSourceType,
  type SourceDirection,
} from "../../domain/index.ts";
import {
  ChannelGateway,
  IdGenerator,
  ProjectRepository,
  ProjectSourceRepository,
} from "../ports/index.ts";
import { CHANNEL_SOURCE_TYPES } from "./channels.ts";
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

export const updateProject = (input: {
  readonly projectId: string;
  readonly name?: string;
  readonly slug?: string | null;
  readonly customInstructions?: string;
}) =>
  Effect.gen(function* () {
    const repo = yield* ProjectRepository;
    const current = yield* repo.get(input.projectId);
    return yield* repo.update({
      ...current,
      name: input.name ?? current.name,
      slug: input.slug === undefined ? current.slug : input.slug,
      customInstructions: input.customInstructions ?? current.customInstructions,
      updatedAt: yield* nowIso,
    });
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

/**
 * Creates a Project and, through the Discord adapter, a new channel for it, linked as the
 * project's default reply channel. The project is kept when the channel can't be created:
 * the result then carries `channelError` so the admin can link an existing channel instead.
 */
export const createProjectWithChannel = (input: {
  readonly orgId: string;
  readonly name: string;
  readonly slug?: string;
  readonly customInstructions?: string;
}) =>
  Effect.gen(function* () {
    const project = yield* createProject(input);
    const created = yield* Effect.result(
      (yield* ChannelGateway).createChannel({ channelType: "discord", name: input.name }),
    );
    if (Result.isFailure(created)) {
      return { project, source: null, channelError: created.failure.message } as const;
    }
    const source = yield* addSource({
      projectId: project.id,
      type: CHANNEL_SOURCE_TYPES.discord,
      externalId: created.success.channelId,
      name: `#${created.success.name}`,
      isDefaultResponse: true,
    });
    return { project, source, channelError: null } as const;
  });
