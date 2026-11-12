import { healthConfig } from "@project-os/config";
import {
  InboundMessage,
  PromptAnswer,
  SlashCommand,
  WorkerRegisterRequest,
} from "@project-os/contracts";
import {
  answerPrompt,
  getTicket,
  handleInbound,
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
}: HttpDeps) => {
  const reply = async (
    set: { status?: number | string },
    effect: Effect.Effect<HttpResult, never, HttpEnv>,
  ) => {
    const result = await run(effect);
    set.status = result.status;
    return result.body;
  };

  return new Elysia({ name: "http-routes" })
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
    .get("/tickets/:id", ({ params, set }) =>
      reply(set, toResult(getTicket({ ticketId: params.id }))),
    )
    .get("/tickets/:id/attachments", ({ params, set }) =>
      reply(
        set,
        toResult(Effect.map(listTicketAttachments(params.id), (attachments) => ({ attachments }))),
      ),
    )
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
