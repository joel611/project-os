import { healthConfig } from "@project-os/config";
import {
  InboundMessage,
  PromptAnswer,
  SlashCommand,
  WorkerRegisterRequest,
} from "@project-os/contracts";
import { AUDIT_KINDS, type AuditKind, type Viewer } from "@project-os/contracts";
import {
  answerPrompt,
  getMyTicket,
  getTicket,
  listMyTicketAttachments,
  listMyTickets,
  handleInbound,
  readAudit,
  readProjectAudit,
  readWorkerAudit,
  type AuditRead,
  listTicketAttachments,
  readActivity,
  redeemWorkerRegistration,
  workerLabel,
  type AgentRuntime,
  type AssetStore,
  type ChannelGateway,
  type ChannelMessageRepository,
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
  type Sidekick,
  type TicketRepository,
  type UserConnections,
  type WorkerLauncher,
  type WorkerRepository,
} from "@project-os/core";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";
import type { Access, Caller } from "../access.ts";
import {
  changeStatusAndNotify,
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
  | ChannelMessageRepository
  | Clock
  | IdGenerator
  | IntentClassifier
  | KeyValueStore
  | MemoryRepository
  | AuditLogRepository
  | ProjectRepository
  | ProjectSourceRepository
  | Sidekick
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
}

export const httpRoutes = ({
  run,
  inbound = {},
  workerStaleMs = healthConfig().workerStaleMs,
  commands,
  prompts = inbound,
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

  /** The person a member is, so a Ticket route can narrow to theirs; undefined for an Operator. */
  const memberPerson = async (request: Request) => {
    const caller = await access.caller(request);
    return caller.kind === "member" ? caller.person : undefined;
  };

  return new Elysia({ name: "http-routes" })
    .get("/me", async ({ request }): Promise<Viewer> => {
      // The route's `member` policy lets in only an Operator (`user`) or a member.
      const caller = (await access.caller(request)) as Extract<
        Caller,
        { kind: "user" } | { kind: "member" }
      >;
      const person = await access.personOf(caller);
      return {
        role: caller.kind === "member" ? "member" : "operator",
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
            Effect.flatMap((answer) => answerPrompt(answer, prompts)),
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
    .get("/tickets/:id", async ({ params, request, set }) => {
      const person = await memberPerson(request);
      return reply(
        set,
        toResult(person ? getMyTicket(params.id, person) : getTicket({ ticketId: params.id })),
      );
    })
    .get("/tickets/:id/attachments", async ({ params, request, set }) => {
      const person = await memberPerson(request);
      const attachments = person
        ? listMyTicketAttachments(params.id, person)
        : listTicketAttachments(params.id);
      return reply(set, toResult(Effect.map(attachments, (list) => ({ attachments: list }))));
    })
    .post("/tickets/:id/status", ({ params, body, set }) =>
      reply(
        set,
        toResult(
          decode(UpdateStatusBody, body).pipe(
            Effect.flatMap((update) => changeStatusAndNotify(params.id, update)),
          ),
        ),
      ),
    );
};
