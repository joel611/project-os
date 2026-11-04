import { TicketStatus } from "@project-os/contracts";
import {
  addSource,
  createProject as createProjectUseCase,
  ProjectRepository,
  TicketRepository,
  updateStatusAndNotify,
} from "@project-os/core";
import { Effect, Schema } from "effect";

const ProjectSourceType = Schema.Literals([
  "discord_channel",
  "email_address",
  "clickup_list",
  "google_drive_folder",
  "github_repo",
]);

export const CreateProjectBody = Schema.Struct({
  orgId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  slug: Schema.optionalKey(Schema.String),
  customInstructions: Schema.optionalKey(Schema.String),
});

export const CreateSourceBody = Schema.Struct({
  type: ProjectSourceType,
  externalId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  direction: Schema.optionalKey(Schema.Literals(["inbound", "outbound", "both"])),
  isDefaultResponse: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
});

export const UpdateStatusBody = Schema.Struct({
  status: TicketStatus,
  error: Schema.optionalKey(Schema.String),
});

export const decode = <S extends Schema.Decoder<unknown>>(schema: S, body: unknown) =>
  Schema.decodeUnknownEffect(schema)(body);

export const createProject = (body: typeof CreateProjectBody.Type) => createProjectUseCase(body);

export const listProjects = Effect.flatMap(ProjectRepository, (repo) => repo.list);

export const linkSource = (projectId: string, body: typeof CreateSourceBody.Type) =>
  addSource({ projectId, ...body });

export const listProjectTickets = (projectId: string) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(projectId);
    const all = yield* (yield* TicketRepository).listByStatus([
      "open",
      "assigned",
      "in_progress",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]);
    return all.filter((t) => t.projectId === projectId);
  });

/** Status change; a `completed` ticket also gets its reply (the ticket-completed hook). */
export const changeStatus = (ticketId: string, body: typeof UpdateStatusBody.Type) =>
  updateStatusAndNotify({
    ticketId,
    status: body.status,
    ...(body.error === undefined ? {} : { error: body.error }),
  });
