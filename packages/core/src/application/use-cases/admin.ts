import { Effect, Result } from "effect";
import {
  aliasFrom,
  InvalidSourceAlias,
  normalizeAlias,
  SourceAlreadyLinked,
  sourceUrl,
  uniqueAlias,
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
      channelDigest: true,
      channelDigestNotify: false,
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
  readonly channelDigest?: boolean;
  readonly channelDigestNotify?: boolean;
}) =>
  Effect.gen(function* () {
    const repo = yield* ProjectRepository;
    const current = yield* repo.get(input.projectId);
    return yield* repo.update({
      ...current,
      name: input.name ?? current.name,
      slug: input.slug === undefined ? current.slug : input.slug,
      customInstructions: input.customInstructions ?? current.customInstructions,
      channelDigest: input.channelDigest ?? current.channelDigest,
      channelDigestNotify: input.channelDigestNotify ?? current.channelDigestNotify,
      updatedAt: yield* nowIso,
    });
  });

/** Validates and normalizes a caller's alias (see `normalizeAlias`). */
const checkAlias = (raw: string) => {
  const alias = normalizeAlias(raw);
  return alias === null
    ? Effect.fail(
        new InvalidSourceAlias({
          alias: raw,
          message:
            "An alias is lowercase letters and digits joined by '-' or '_', at most 40 characters.",
        }),
      )
    : Effect.succeed(alias);
};

/** Alias for a source nobody named: what kind of source it is. */
const TYPE_ALIAS: Record<ProjectSourceType, string> = {
  discord_channel: "discord",
  email_address: "email",
  clickup_list: "clickup",
  google_drive_folder: "drive",
  github_repo: "repo",
};

const blankToNull = (text: string | null | undefined) => {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
};

/**
 * Links a source to a project. `alias` names what the source is for and must be unique in the
 * project; people and the admin dialogue always give one. When it is left out (channels the
 * Coordinator links itself) it is derived from `name` (or the type, when the name is just the
 * id), with a `-2`… suffix if that is taken.
 */
export const addSource = (input: {
  readonly projectId: string;
  readonly type: ProjectSourceType;
  readonly externalId: string;
  readonly name: string;
  readonly alias?: string | undefined;
  readonly description?: string | null | undefined;
  readonly direction?: SourceDirection;
  readonly isDefaultResponse?: boolean;
  readonly config?: unknown;
}) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(input.projectId);
    const sources = yield* ProjectSourceRepository;
    const alias =
      input.alias === undefined
        ? uniqueAlias(
            // A name that is just the id (e.g. a raw channel id) says nothing: use the type.
            input.name === input.externalId
              ? TYPE_ALIAS[input.type]
              : aliasFrom(input.name, TYPE_ALIAS[input.type]),
            new Set((yield* sources.listByProject(input.projectId)).map((s) => s.alias)),
          )
        : yield* checkAlias(input.alias);
    const at = yield* nowIso;
    const inserted = yield* sources.insert({
      id: yield* (yield* IdGenerator).next,
      projectId: input.projectId,
      type: input.type,
      externalId: input.externalId,
      name: input.name,
      alias,
      description: blankToNull(input.description),
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
 * A project's active sources as Workers see them: alias and description first, so a Worker
 * told "the design docs" can find the Drive folder or repo they mean.
 */
export const listProjectSources = (input: { readonly projectId: string }) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(input.projectId);
    const sources = yield* (yield* ProjectSourceRepository).listByProject(input.projectId);
    return sources
      .filter((s) => s.status === "active")
      .map((s) => ({
        alias: s.alias,
        description: s.description,
        type: s.type,
        externalId: s.externalId,
        name: s.name,
        url: sourceUrl(s),
      }));
  });

/** Renames a source's alias and/or changes its description (`null` or blank clears it). */
export const updateSource = (input: {
  readonly projectId: string;
  readonly sourceId: string;
  readonly alias?: string | undefined;
  readonly description?: string | null | undefined;
}) =>
  Effect.gen(function* () {
    const alias = input.alias === undefined ? undefined : yield* checkAlias(input.alias);
    return yield* (yield* ProjectSourceRepository).update(input.projectId, input.sourceId, {
      ...(alias === undefined ? {} : { alias }),
      ...(input.description === undefined ? {} : { description: blankToNull(input.description) }),
      updatedAt: yield* nowIso,
    });
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
      return yield* new SourceAlreadyLinked({
        type,
        externalId: input.externalId,
        projectId: existing.projectId,
      });
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
