import { healthConfig } from "@project-os/config";
import type { SetRoleResult, SharedAccounts } from "@project-os/auth";
import {
  AssignEmail,
  AssignSharedAccount,
  CreateSharedAccount,
  InboundMessage,
  PromptAnswer,
  SlashCommand,
  WorkerRegisterRequest,
} from "@project-os/contracts";
import {
  AUDIT_KINDS,
  type AuditKind,
  can,
  type Member,
  ROLE_GRANTS,
  type Role,
  SetMemberRole,
  SetMyEmailEnabled,
  type Viewer,
} from "@project-os/contracts";
import {
  addSkillsToSet,
  answerScopePrompt,
  assignEmail,
  getMyEmail,
  listEmailLabels,
  setMailboxEnabled,
  audit,
  browseSkillSource,
  checkSkillUpdates,
  createTaskType,
  deleteTaskType,
  getTaskType,
  listTaskTypes,
  removeSkillFromSet,
  updateTaskType,
  withTaskType,
  updateSkillsInSet,
  getMyTicket,
  getTicket,
  listMyTicketAttachments,
  listMyTickets,
  listTicketRuns,
  readTicketRun,
  handleInbound,
  readAudit,
  readProjectAudit,
  readWorkerAudit,
  type AuditRead,
  listTicketAttachments,
  readActivity,
  reassignTicketTo,
  changeTicketStatus,
  redeemWorkerRegistration,
  workerLabel,
  type AgentRuntime,
  type AssetStore,
  type ChannelGateway,
  type Person,
  type ChannelDigester,
  type EmailSource,
  type ChannelMessageRepository,
  type EmailRepository,
  type Clock,
  type HandleInboundConfig,
  type IdGenerator,
  type AuditLogRepository,
  type IntentClassifier,
  type KeyValueStore,
  type MemoryRepository,
  type PromptAnswerConfig,
  type ProjectRepository,
  type ProjectSourceRepository,
  type RunRepository,
  type Sidekick,
  type SkillRepository,
  type SkillSource,
  type TicketRepository,
  type UserConnections,
  type WorkerLauncher,
  type WorkerRepository,
} from "@project-os/core";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";
import { type Access, type Caller, roleOf } from "../access.ts";
import {
  AddSkillsBody,
  AssignBody,
  BrowseSkillsBody,
  CreateTaskTypeBody,
  UpdateTaskTypeBody,
  UpdateSkillsBody,
  CreateProjectBody,
  createProject,
  CreateSourceBody,
  UpdateSourceBody,
  editSource,
  unlinkSource,
  decode,
  getProject,
  linkSource,
  listProjectMemory,
  listProjects,
  listProjectTickets,
  getWorker,
  listWorkers,
  UpdateProjectBody,
  updateProject,
  UpdateStatusBody,
} from "./admin.ts";
import { type CommandsConfig, runCommand, watcherScriptConfig } from "./commands.ts";
import { toResult, type HttpResult } from "./result.ts";
import { installScript } from "./watcher-install.ts";

const decodeCommand = Schema.decodeUnknownOption(SlashCommand);

/** The body as `schema` says, or undefined when it doesn't fit. */
const decodeBody = <S extends Schema.Decoder<unknown>>(schema: S, body: unknown) => {
  const parsed = Schema.decodeUnknownOption(schema)(body);
  return parsed._tag === "Some" ? (parsed.value as S["Type"]) : undefined;
};

export type { CommandsConfig, HandleInboundConfig };

const isAuditKind = (value: string): value is AuditKind =>
  (AUDIT_KINDS as ReadonlyArray<string>).includes(value);

/** `?kind=&before=&limit=` for the audit feeds; a string is the 400 message. */
const auditQuery = (
  query: Record<string, string | undefined>,
): Omit<AuditRead, "projectId"> | string => {
  const { kind, before, limit } = query;
  if (kind && !isAuditKind(kind)) return `kind must be one of ${AUDIT_KINDS.join(", ")}`;
  const size = limit ? Number(limit) : undefined;
  if (size !== undefined && (!Number.isInteger(size) || size < 1)) {
    return "limit must be a positive whole number";
  }
  return {
    ...(kind && { kind: kind as AuditKind }),
    ...(before && { before }),
    ...(size !== undefined && { limit: size }),
  };
};

export type HttpEnv =
  | AgentRuntime
  | AssetStore
  | ChannelGateway
  | ChannelDigester
  | ChannelMessageRepository
  | Clock
  | EmailRepository
  | EmailSource
  | IdGenerator
  | IntentClassifier
  | KeyValueStore
  | MemoryRepository
  | AuditLogRepository
  | ProjectRepository
  | ProjectSourceRepository
  | RunRepository
  | Sidekick
  | SkillRepository
  | SkillSource
  | TicketRepository
  | UserConnections
  | WorkerLauncher
  | WorkerRepository;

export interface HttpDeps {
  readonly run: <A>(effect: Effect.Effect<A, never, HttpEnv>) => Promise<A>;
  readonly inbound?: HandleInboundConfig;
  /** Worker `lastSeenAt` older than this reads as offline in `GET /workers`. Default: env. */
  readonly workerStaleMs?: number;
  /** Slash commands from Channel Adapters (`POST /commands`). Omitted: every command 501s. */
  readonly commands?: CommandsConfig;
  /** Who may answer prompts (`POST /prompts/answer`). Default: the admin list in `inbound`. */
  readonly prompts?: PromptAnswerConfig;
  /** People with a dashboard sign-in or channel identity (`GET /members`). Omitted: 501. */
  readonly members?: () => Promise<ReadonlyArray<Member>>;
  /** Changes a dashboard user's role (`POST /members/:key/role`). Omitted: 501. */
  readonly setRole?: (userId: string, role: Role) => Promise<SetRoleResult>;
  /** Shared connector accounts admins link and assign (`/shared-accounts`). Omitted: 501. */
  readonly sharedAccounts?: SharedAccounts;
  /** The Email Digest is on (`EMAIL_DIGEST`): people may switch their mailbox on. */
  readonly emailDigest?: boolean;
}

export const httpRoutes = ({
  run,
  inbound = {},
  workerStaleMs = healthConfig().workerStaleMs,
  commands,
  prompts = inbound,
  members,
  setRole,
  sharedAccounts,
  emailDigest = false,
  access,
}: HttpDeps & {
  /** Who is calling: members get only their own Tickets on the routes they may use. */
  readonly access: Access;
}) => {
  const reply = async (
    set: { status?: number | string },
    effect: Effect.Effect<HttpResult, never, HttpEnv>,
  ) => {
    const result = await run(effect);
    set.status = result.status;
    return result.body;
  };

  /**
   * Which Tickets the caller may read: every one with `ticket:read`, else the ones their channel
   * person is involved in (`ticket:read-own`), else none: a dashboard user with the `member` role
   * whose Google account is linked to no channel person has no Tickets of their own.
   */
  const ticketScope = async (
    request: Request,
  ): Promise<{ readonly person?: Person; readonly none?: true }> => {
    const caller = await access.caller(request);
    const role = roleOf(caller);
    if (role && can(role, "ticket", "read")) return {};
    const person = await access.personOf(caller);
    return person ? { person } : { none: true };
  };

  /**
   * Runs a ticket route for the caller's scope: everything for an Operator, their own Tickets for
   * a member, and a plain 404 for someone with no Tickets of their own.
   */
  const forTicket = async (
    request: Request,
    set: { status?: number | string },
    make: (person: Person | undefined) => Effect.Effect<HttpResult, never, HttpEnv>,
  ) => {
    const scope = await ticketScope(request);
    if (scope.none) {
      set.status = 404;
      return { error: "TicketNotFound" };
    }
    return reply(set, make(scope.person));
  };

  /** The admin calling, as an audit actor: `shared-accounts` routes admit only Operators. */
  const adminActor = async (request: Request) => {
    const caller = (await access.caller(request)) as Extract<Caller, { kind: "user" }>;
    return { type: "person", id: caller.userId, name: caller.name } as const;
  };

  const unconfigured = (set: { status?: number | string }) => {
    set.status = 501;
    return { error: "shared accounts need an OAuth client and PUBLIC_URL" };
  };

  return new Elysia({ name: "http-routes" })
    .get("/me", async ({ request }): Promise<Viewer> => {
      // The route's `member` policy lets in only an Operator (`user`) or a member.
      const caller = (await access.caller(request)) as Extract<
        Caller,
        { kind: "user" } | { kind: "member" }
      >;
      const person = await access.personOf(caller);
      const role = roleOf(caller)!;
      return {
        role,
        permissions: ROLE_GRANTS[role],
        name: caller.kind === "member" ? (caller.person.name ?? caller.person.id) : caller.name,
        person: person
          ? { channelType: person.channelType, id: person.id, name: person.name ?? null }
          : null,
      };
    })
    .get("/me/tickets", async ({ request, set }) => {
      const person = await access.personOf(await access.caller(request));
      if (!person) return { tickets: [], projects: [] };
      return reply(set, toResult(listMyTickets(person)));
    })
    .get("/me/email", async ({ request }) => {
      const person = await access.personOf(await access.caller(request));
      // An Operator with no channel identity has no mailbox of their own.
      if (!person) return run(getMyEmail({ channelType: "discord", id: "" }, false));
      return run(getMyEmail(person, emailDigest));
    })
    .post("/me/email/enabled", async ({ request, body, set }) => {
      const person = await access.personOf(await access.caller(request));
      const parsed = decodeBody(SetMyEmailEnabled, body);
      if (!emailDigest || !person || !parsed) {
        set.status = !emailDigest ? 501 : !person ? 403 : 400;
        return {
          error: !emailDigest
            ? "Email is not turned on here"
            : !person
              ? "Link your Discord account to read your mail"
              : "enabled must be true or false",
        };
      }
      return reply(
        set,
        toResult(
          setMailboxEnabled(person, parsed.enabled, parsed.label).pipe(
            Effect.andThen(getMyEmail(person, emailDigest)),
          ),
        ),
      );
    })
    .get("/me/email/labels", async ({ request, set }) => {
      const person = await access.personOf(await access.caller(request));
      if (!emailDigest || !person) {
        set.status = !emailDigest ? 501 : 403;
        return {
          error: !emailDigest ? "Email is not turned on here" : "No mailbox for this account",
        };
      }
      return reply(set, toResult(listEmailLabels(person)));
    })
    .post("/me/email/:id/assign", async ({ request, params, body, set }) => {
      const person = await access.personOf(await access.caller(request));
      const parsed = decodeBody(AssignEmail, body);
      if (!person || !parsed) {
        set.status = !person ? 403 : 400;
        return {
          error: !person ? "No mailbox for this account" : "projectId is a project id or null",
        };
      }
      return reply(set, toResult(assignEmail(person, params.id, parsed.projectId)));
    })
    .get("/members", async ({ set }) => {
      if (!members) {
        set.status = 501;
        return { error: "the member list is not configured" };
      }
      return members();
    })
    .post("/members/:key/role", async ({ params, body, request, set }) => {
      if (!setRole) {
        set.status = 501;
        return { error: "roles are not configured" };
      }
      const parsed = decodeBody(SetMemberRole, body);
      if (!parsed) {
        set.status = 400;
        return { error: "role must be admin or member" };
      }
      const result = await setRole(params.key, parsed.role);
      if (result === "not_found") {
        set.status = 404;
        return { error: "MemberNotFound" };
      }
      if (result === "last_admin") {
        set.status = 409;
        return { error: "LastAdmin" };
      }
      const actor = await adminActor(request);
      await run(
        audit({
          kind: "connection",
          action: "member_role_changed",
          actor,
          summary: `Set ${params.key}'s dashboard role to ${parsed.role}`,
          payload: { userId: params.key, role: parsed.role },
        }),
      );
      return { role: parsed.role };
    })
    .get("/shared-accounts", ({ set }) =>
      sharedAccounts ? sharedAccounts.list() : unconfigured(set),
    )
    .post("/shared-accounts", async ({ body, request, set }) => {
      if (!sharedAccounts) return unconfigured(set);
      const parsed = decodeBody(CreateSharedAccount, body);
      const label = parsed?.label.trim().slice(0, 60);
      if (!parsed || !label) {
        set.status = 400;
        return { error: "provider and a label are required" };
      }
      const actor = await adminActor(request);
      const created = await sharedAccounts.create({
        provider: parsed.provider,
        label,
        createdBy: actor.id,
      });
      await run(
        audit({
          kind: "connection",
          action: "shared_account_added",
          actor,
          summary: `Added shared ${parsed.provider} account "${label}"`,
          payload: { provider: parsed.provider, sharedAccountId: created.account.id, label },
        }),
      );
      return created;
    })
    .post("/shared-accounts/:id/connect", async ({ params, set }) => {
      if (!sharedAccounts) return unconfigured(set);
      const link = await sharedAccounts.reconnect(params.id);
      if (!link) {
        set.status = 404;
        return { error: "SharedAccountNotFound" };
      }
      return link;
    })
    .delete("/shared-accounts/:id", async ({ params, request, set }) => {
      if (!sharedAccounts) return unconfigured(set);
      const removed = await sharedAccounts.remove(params.id);
      if (!removed) {
        set.status = 404;
        return { error: "SharedAccountNotFound" };
      }
      await run(
        audit({
          kind: "connection",
          action: "shared_account_removed",
          actor: await adminActor(request),
          summary: `Removed shared ${removed.provider} account "${removed.label}" and its assignments`,
          payload: {
            provider: removed.provider,
            sharedAccountId: removed.id,
            label: removed.label,
          },
        }),
      );
      return { removed: true };
    })
    .post("/shared-accounts/assignments", async ({ body, request, set }) => {
      if (!sharedAccounts) return unconfigured(set);
      const parsed = decodeBody(AssignSharedAccount, body);
      if (!parsed) {
        set.status = 400;
        return {
          error: "channelType, personId, provider and sharedAccountId (or null) are required",
        };
      }
      const actor = await adminActor(request);
      const result = await sharedAccounts.assign({ ...parsed, assignedBy: actor.id });
      if (!result.ok) {
        set.status = result.error === "not_found" ? 404 : 400;
        return { error: result.error };
      }
      // Unassigning someone who had nothing assigned changes nothing, so isn't logged.
      const account = result.account;
      if (!account) return { ok: true };
      const who = `${parsed.channelType}:${parsed.personId}`;
      const unassigned = parsed.sharedAccountId === null;
      await run(
        audit({
          kind: "connection",
          action: unassigned ? "shared_account_unassigned" : "shared_account_assigned",
          actor,
          summary: `${unassigned ? "Unassigned" : "Assigned"} shared ${parsed.provider} account "${account.label}" ${unassigned ? "from" : "to"} ${who}`,
          payload: {
            provider: parsed.provider,
            sharedAccountId: account.id,
            label: account.label,
            person: { channelType: parsed.channelType, id: parsed.personId },
          },
        }),
      );
      return { ok: true };
    })
    .post("/inbound", ({ body, set }) =>
      reply(
        set,
        toResult(
          decode(InboundMessage, body).pipe(
            Effect.flatMap((message) => handleInbound(message, inbound)),
          ),
        ),
      ),
    )
    .post("/commands", async ({ body, set }) => {
      const parsed = decodeCommand(body);
      if (parsed._tag === "None") {
        set.status = 400;
        return { error: "invalid slash command" };
      }
      if (!commands) {
        set.status = 501;
        return { error: "slash commands are not configured" };
      }
      return runCommand(parsed.value, commands);
    })
    .post("/prompts/answer", ({ body, set }) =>
      reply(
        set,
        toResult(
          decode(PromptAnswer, body).pipe(
            Effect.flatMap((answer) => answerScopePrompt(answer, prompts, inbound)),
          ),
        ),
      ),
    )
    .get("/projects", ({ set }) => reply(set, toResult(listProjects)))
    .post("/projects", ({ body, set }) =>
      reply(
        set,
        toResult(decode(CreateProjectBody, body).pipe(Effect.flatMap(createProject)), 201),
      ),
    )
    .get("/projects/:id", ({ params, set }) => reply(set, toResult(getProject(params.id))))
    .patch("/projects/:id", ({ params, body, set }) =>
      reply(
        set,
        toResult(
          decode(UpdateProjectBody, body).pipe(
            Effect.flatMap((patch) => updateProject(params.id, patch)),
          ),
        ),
      ),
    )
    .get("/projects/:id/memory", ({ params, set }) =>
      reply(set, toResult(listProjectMemory(params.id))),
    )
    .get("/audit", ({ query, set }) => {
      const read = auditQuery(query);
      if (typeof read === "string") {
        set.status = 400;
        return { error: read };
      }
      const projectId =
        typeof query.projectId === "string" && query.projectId ? query.projectId : undefined;
      return reply(set, toResult(readAudit({ ...read, ...(projectId && { projectId }) })));
    })
    .get("/projects/:id/audit", ({ params, query, set }) => {
      const read = auditQuery(query);
      if (typeof read === "string") {
        set.status = 400;
        return { error: read };
      }
      return reply(set, toResult(readProjectAudit(params.id, read)));
    })
    .post("/projects/:id/sources", ({ params, body, set }) =>
      reply(
        set,
        toResult(
          decode(CreateSourceBody, body).pipe(
            Effect.flatMap((source) => linkSource(params.id, source)),
          ),
          201,
        ),
      ),
    )
    .patch("/projects/:id/sources/:sourceId", ({ params, body, set }) =>
      reply(
        set,
        toResult(
          decode(UpdateSourceBody, body).pipe(
            Effect.flatMap((patch) => editSource(params.id, params.sourceId, patch)),
          ),
        ),
      ),
    )
    .delete("/projects/:id/sources/:sourceId", ({ params, set }) =>
      reply(set, toResult(unlinkSource(params.id, params.sourceId))),
    )
    .get("/task-types", ({ set }) => reply(set, toResult(listTaskTypes)))
    .post("/task-types", ({ body, set }) =>
      reply(
        set,
        toResult(
          decode(CreateTaskTypeBody, body).pipe(
            Effect.flatMap(({ name, description, instructions }) =>
              createTaskType({
                name,
                description: description ?? "",
                ...(instructions !== undefined && { instructions }),
              }),
            ),
          ),
          201,
        ),
      ),
    )
    .get("/task-types/:id", ({ params, set }) => reply(set, toResult(getTaskType(params.id))))
    .patch("/task-types/:id", ({ params, body, set }) =>
      reply(
        set,
        toResult(
          decode(UpdateTaskTypeBody, body).pipe(
            Effect.flatMap((patch) => updateTaskType(params.id, patch)),
          ),
        ),
      ),
    )
    .delete("/task-types/:id", ({ params, set }) =>
      reply(set, toResult(deleteTaskType(params.id).pipe(Effect.as({ deleted: true })))),
    )
    .post("/task-types/browse", ({ body, set }) =>
      reply(
        set,
        toResult(
          decode(BrowseSkillsBody, body).pipe(
            Effect.flatMap(({ source }) => browseSkillSource(source)),
          ),
        ),
      ),
    )
    .post("/task-types/:id/skills", async ({ params, body, request, set }) => {
      // The route's `user` policy lets in only an Operator.
      const caller = (await access.caller(request)) as Extract<Caller, { kind: "user" }>;
      return reply(
        set,
        toResult(
          decode(AddSkillsBody, body).pipe(
            Effect.flatMap(({ source, slugs }) =>
              addSkillsToSet({ setId: params.id, source, slugs, by: caller.name }),
            ),
            Effect.map((skills) => ({ skills })),
          ),
          201,
        ),
      );
    })
    .delete("/task-types/:id/skills/:skillId", ({ params, set }) =>
      reply(set, toResult(removeSkillFromSet(params.skillId).pipe(Effect.as({ deleted: true })))),
    )
    .get("/task-types/:id/updates", ({ params, set }) =>
      reply(set, toResult(checkSkillUpdates(params.id))),
    )
    .post("/task-types/:id/update", async ({ params, body, request, set }) => {
      const caller = (await access.caller(request)) as Extract<Caller, { kind: "user" }>;
      return reply(
        set,
        toResult(
          decode(UpdateSkillsBody, body ?? {}).pipe(
            Effect.flatMap(({ skillIds }) =>
              updateSkillsInSet({
                setId: params.id,
                ...(skillIds && { skillIds }),
                by: caller.name,
              }),
            ),
            Effect.map((skills) => ({ skills })),
          ),
        ),
      );
    })
    .get("/projects/:id/tickets", ({ params, set }) =>
      reply(set, toResult(listProjectTickets(params.id))),
    )
    .get("/workers", ({ set }) => reply(set, toResult(listWorkers(workerStaleMs))))
    .get("/workers/:id", ({ params, set }) =>
      reply(set, toResult(getWorker(params.id, workerStaleMs))),
    )
    .get("/workers/:id/audit", ({ params, query, set }) => {
      const read = auditQuery(query);
      if (typeof read === "string") {
        set.status = 400;
        return { error: read };
      }
      return reply(set, toResult(readWorkerAudit(params.id, read)));
    })
    .get("/watcher/install.sh", ({ set }) => {
      const workers = commands?.workers;
      if (!workers) {
        set.status = 501;
        return { error: "registered workers are not configured" };
      }
      set.headers["content-type"] = "text/x-shellscript; charset=utf-8";
      return installScript(watcherScriptConfig(workers));
    })
    .post("/workers/register", ({ body, set }) =>
      reply(
        set,
        toResult(
          decode(WorkerRegisterRequest, body).pipe(
            Effect.flatMap(redeemWorkerRegistration),
            Effect.map(({ worker, secret }) => ({
              workerId: worker.id,
              name: workerLabel(worker),
              secret,
            })),
          ),
          201,
        ),
      ),
    )
    .get("/activity", ({ query, set }) => {
      const since = typeof query.since === "string" ? query.since : undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        set.status = 400;
        return { error: "since must be an ISO timestamp" };
      }
      return reply(
        set,
        toResult(
          readActivity({
            ...(since === undefined ? {} : { since }),
            staleAfterMs: workerStaleMs,
          }),
        ),
      );
    })
    .get("/tickets/:id", ({ params, request, set }) =>
      forTicket(request, set, (person) =>
        toResult(
          (person ? getMyTicket(params.id, person) : getTicket({ ticketId: params.id })).pipe(
            Effect.flatMap(withTaskType),
          ),
        ),
      ),
    )
    .get("/tickets/:id/attachments", ({ params, request, set }) =>
      forTicket(request, set, (person) =>
        toResult(
          Effect.map(
            person ? listMyTicketAttachments(params.id, person) : listTicketAttachments(params.id),
            (list) => ({ attachments: list }),
          ),
        ),
      ),
    )
    .get("/tickets/:id/runs", ({ params, request, set }) =>
      forTicket(request, set, (person) =>
        toResult(listTicketRuns(params.id, person).pipe(Effect.map((runs) => ({ runs })))),
      ),
    )
    .get("/tickets/:id/runs/:runId", ({ params, request, set }) =>
      forTicket(request, set, (person) => toResult(readTicketRun(params.id, params.runId, person))),
    )
    .post("/tickets/:id/status", async ({ params, body, request, set }) => {
      // The route's `user` policy lets in only an Operator.
      const caller = (await access.caller(request)) as Extract<Caller, { kind: "user" }>;
      return reply(
        set,
        toResult(
          decode(UpdateStatusBody, body).pipe(
            Effect.flatMap((update) =>
              changeTicketStatus({
                ...update,
                ticketId: params.id,
                by: { type: "person", id: caller.userId, name: caller.name },
              }),
            ),
          ),
        ),
      );
    })
    .post("/tickets/:id/assign", async ({ params, body, request, set }) => {
      // The route's `user` policy lets in only an Operator.
      const caller = (await access.caller(request)) as Extract<Caller, { kind: "user" }>;
      return reply(
        set,
        toResult(
          decode(AssignBody, body).pipe(
            Effect.flatMap(({ workerId }) =>
              reassignTicketTo({
                ticketId: params.id,
                workerId,
                by: { type: "person", id: caller.userId, name: caller.name },
              }),
            ),
          ),
        ),
      );
    });
};
