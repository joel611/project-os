import { ProjectSourceType, TICKET_STATUSES, TicketStatus } from "@project-os/contracts";
import {
  addSource,
  updateProject as updateProjectUseCase,
  Clock,
  createProject as createProjectUseCase,
  ProjectRepository,
  ProjectSourceRepository,
  readMemory,
  removeSource,
  TicketRepository,
  updateSource,
  updateStatusAndNotify,
  WorkerRepository,
  workerStatus,
} from "@project-os/core";
import { Effect, Schema } from "effect";

export const CreateProjectBody = Schema.Struct({
  orgId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  slug: Schema.optionalKey(Schema.String),
  customInstructions: Schema.optionalKey(Schema.String),
});

export const UpdateProjectBody = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
  customInstructions: Schema.optionalKey(Schema.String),
  channelDigest: Schema.optionalKey(Schema.Boolean),
  channelDigestNotify: Schema.optionalKey(Schema.Boolean),
});

export const CreateSourceBody = Schema.Struct({
  type: ProjectSourceType,
  externalId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  alias: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  direction: Schema.optionalKey(Schema.Literals(["inbound", "outbound", "both"])),
  isDefaultResponse: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
});

export const UpdateSourceBody = Schema.Struct({
  alias: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const UpdateStatusBody = Schema.Struct({
  status: TicketStatus,
  error: Schema.optionalKey(Schema.String),
});

export const CreateSkillSetBody = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

export const UpdateSkillSetBody = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});

export const BrowseSkillsBody = Schema.Struct({ source: Schema.NonEmptyString });

export const AddSkillsBody = Schema.Struct({
  source: Schema.NonEmptyString,
  slugs: Schema.NonEmptyArray(Schema.NonEmptyString),
});

export const UpdateSkillsBody = Schema.Struct({
  skillIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});

export const AssignBody = Schema.Struct({ workerId: Schema.NonEmptyString });

export const decode = <S extends Schema.Decoder<unknown>>(schema: S, body: unknown) =>
  Schema.decodeUnknownEffect(schema)(body);

export const createProject = (body: typeof CreateProjectBody.Type) => createProjectUseCase(body);

export const updateProject = (projectId: string, body: typeof UpdateProjectBody.Type) =>
  updateProjectUseCase({ projectId, ...body });

export const listProjects = Effect.flatMap(ProjectRepository, (repo) => repo.list);

export const getProject = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* (yield* ProjectRepository).get(projectId);
    const sources = yield* (yield* ProjectSourceRepository).listByProject(projectId);
    return { project, sources };
  });

export const listProjectMemory = (projectId: string) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(projectId);
    return yield* readMemory({ projectId });
  });

export const listWorkers = (staleAfterMs: number) =>
  Effect.gen(function* () {
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const workers = yield* (yield* WorkerRepository).list;
    return workers.map((w) => ({ ...w, status: workerStatus(w, now, staleAfterMs) }));
  });

/** Most Tickets `GET /workers/:id` returns, newest first. */
export const WORKER_TICKET_LIMIT = 50;

/** One Worker with its online status and the Tickets assigned to it, newest first. */
export const getWorker = (workerId: string, staleAfterMs: number) =>
  Effect.gen(function* () {
    const now = yield* Effect.flatMap(Clock, (c) => c.now);
    const worker = yield* (yield* WorkerRepository).get(workerId);
    const all = yield* (yield* TicketRepository).listByStatus(TICKET_STATUSES);
    const tickets = all
      .filter((t) => t.workerId === workerId)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, WORKER_TICKET_LIMIT);
    return { worker: { ...worker, status: workerStatus(worker, now, staleAfterMs) }, tickets };
  });

export const linkSource = (projectId: string, body: typeof CreateSourceBody.Type) =>
  addSource({ projectId, ...body });

export const editSource = (
  projectId: string,
  sourceId: string,
  body: typeof UpdateSourceBody.Type,
) => updateSource({ projectId, sourceId, ...body });

export const unlinkSource = (projectId: string, sourceId: string) =>
  removeSource({ projectId, sourceId });

export const listProjectTickets = (projectId: string) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(projectId);
    const all = yield* (yield* TicketRepository).listByStatus(TICKET_STATUSES);
    return all.filter((t) => t.projectId === projectId);
  });

export const changeStatusAndNotify = (ticketId: string, body: typeof UpdateStatusBody.Type) =>
  updateStatusAndNotify({
    ticketId,
    status: body.status,
    ...(body.error === undefined ? {} : { error: body.error }),
  });
