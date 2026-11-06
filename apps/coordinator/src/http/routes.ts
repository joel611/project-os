import { healthConfig } from "@project-os/config";
import { InboundMessage, SlashCommand } from "@project-os/contracts";
import {
  getTicket,
  handleInbound,
  readActivity,
  type AgentRuntime,
  type ChannelGateway,
  type Clock,
  type HandleInboundConfig,
  type IdGenerator,
  type IntentClassifier,
  type KeyValueStore,
  type MemoryRepository,
  type ProjectRepository,
  type ProjectSourceRepository,
  type TicketRepository,
  type WorkerRepository,
} from "@project-os/core";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";
import {
  changeStatus,
  CreateProjectBody,
  createProject,
  CreateSourceBody,
  UpdateSourceBody,
  editSource,
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
import { type CommandsConfig, runCommand } from "./commands.ts";
import { toResult, type HttpResult } from "./result.ts";

const decodeCommand = Schema.decodeUnknownOption(SlashCommand);

export type { CommandsConfig, HandleInboundConfig };

/** Ports the HTTP routes need from the provider Layer. */
export type HttpEnv =
  | AgentRuntime
  | ChannelGateway
  | Clock
  | IdGenerator
  | IntentClassifier
  | KeyValueStore
  | MemoryRepository
  | ProjectRepository
  | ProjectSourceRepository
  | TicketRepository
  | WorkerRepository;

export interface HttpDeps {
  /** Runs an effect against the provider Layer chosen by the entry file. */
  readonly run: <A>(effect: Effect.Effect<A, never, HttpEnv>) => Promise<A>;
  readonly inbound?: HandleInboundConfig;
  /** Worker `lastSeenAt` older than this reads as offline in `GET /workers`. Default: env. */
  readonly workerStaleMs?: number;
  /** Slash commands from Channel Adapters (`POST /commands`). Omitted: every command 501s. */
  readonly commands?: CommandsConfig;
}

/** Ingress + minimal admin API (docs/technical-architecture.md §6). Transport only. */
export const httpRoutes = ({
  run,
  inbound = {},
  workerStaleMs = healthConfig().workerStaleMs,
  commands,
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
    .get("/projects/:id/tickets", ({ params, set }) =>
      reply(set, toResult(listProjectTickets(params.id))),
    )
    .get("/workers", ({ set }) => reply(set, toResult(listWorkers(workerStaleMs))))
    .get("/activity", ({ query, set }) => {
      const since = typeof query.since === "string" ? query.since : undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        set.status = 400;
        return { error: "since must be an ISO timestamp" };
      }
      return reply(
        set,
        toResult(
          readActivity({ ...(since === undefined ? {} : { since }), staleAfterMs: workerStaleMs }),
        ),
      );
    })
    .get("/tickets/:id", ({ params, set }) =>
      reply(set, toResult(getTicket({ ticketId: params.id }))),
    )
    .post("/tickets/:id/status", ({ params, body, set }) =>
      reply(
        set,
        toResult(
          decode(UpdateStatusBody, body).pipe(
            Effect.flatMap((update) => changeStatus(params.id, update)),
          ),
        ),
      ),
    );
};
