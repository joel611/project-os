import { TicketStatus } from "@project-os/contracts";
import {
  IdGenerator,
  nowIso,
  onTicketCompleted,
  ProjectRepository,
  ProjectSourceRepository,
  TicketRepository,
  updateStatus,
  type Project,
  type ProjectSource,
  type Ticket,
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

export const createProject = (body: typeof CreateProjectBody.Type) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    return yield* (yield* ProjectRepository).insert({
      id: yield* (yield* IdGenerator).next,
      orgId: body.orgId,
      name: body.name,
      slug: body.slug ?? null,
      customInstructions: body.customInstructions ?? "",
      defaultResponseChannelId: null,
      status: "active",
      createdBy: null,
      createdAt: at,
      updatedAt: at,
    } satisfies Project);
  });

export const listProjects = Effect.flatMap(ProjectRepository, (repo) => repo.list);

export const linkSource = (projectId: string, body: typeof CreateSourceBody.Type) =>
  Effect.gen(function* () {
    yield* (yield* ProjectRepository).get(projectId);
    const sources = yield* ProjectSourceRepository;
    const at = yield* nowIso;
    const inserted = yield* sources.insert({
      id: yield* (yield* IdGenerator).next,
      projectId,
      type: body.type,
      externalId: body.externalId,
      name: body.name,
      direction: body.direction ?? "both",
      isDefaultResponse: false,
      config: body.config ?? null,
      status: "active",
      connectedBy: null,
      createdAt: at,
      updatedAt: at,
    } satisfies ProjectSource);
    // `setDefaultResponse` clears the flag on the project's other sources.
    return body.isDefaultResponse === true
      ? yield* sources.setDefaultResponse(projectId, inserted.id)
      : inserted;
  });

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

/** Ticket-completed hook: composes and sends the reply once a ticket reaches `completed`. */
export const notifyIfCompleted = (ticket: Ticket) =>
  ticket.status === "completed"
    ? Effect.as(onTicketCompleted({ ticketId: ticket.id }), ticket)
    : Effect.succeed(ticket);

export const changeStatus = (ticketId: string, body: typeof UpdateStatusBody.Type) =>
  updateStatus({
    ticketId,
    status: body.status,
    ...(body.error === undefined ? {} : { error: body.error }),
  }).pipe(Effect.flatMap(notifyIfCompleted));
