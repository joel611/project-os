import {
  ActivityFeed,
  MemoryEntry,
  Project,
  ProjectSource,
  Ticket,
  TicketEvent,
  Worker,
  WorkerStatus,
} from "@project-os/contracts";
import { Schema } from "effect";
import type { SourceInput } from "@/model";

const WorkerView = Schema.Struct({ ...Worker.fields, status: WorkerStatus });
export type WorkerView = typeof WorkerView.Type;

const ProjectDetail = Schema.Struct({ project: Project, sources: Schema.Array(ProjectSource) });
export type ProjectDetail = typeof ProjectDetail.Type;

const TicketDetail = Schema.Struct({ ticket: Ticket, events: Schema.Array(TicketEvent) });
export type TicketDetail = typeof TicketDetail.Type;

export interface ProjectPatch {
  readonly name?: string;
  readonly customInstructions?: string;
}

/** A Coordinator error response: HTTP status plus its tagged error name. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** Gateway statuses without a Coordinator error body come from the dev proxy: nothing is listening. */
const GATEWAY_STATUSES = [502, 503, 504];

const errorCode = (body: unknown, res: Response): string => {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  )
    return body.error;
  return GATEWAY_STATUSES.includes(res.status) ? "Unreachable" : res.statusText;
};

const UNREACHABLE = "Can't reach the Coordinator. Is it running?";

/** One line for the operator, whatever went wrong between the dashboard and the Coordinator. */
export const describeError = (error: Error): string => {
  if (error instanceof TypeError) return UNREACHABLE;
  if (!(error instanceof ApiError))
    return `Unexpected response from the Coordinator: ${error.message}`;
  if (error.code === "Unreachable") return UNREACHABLE;
  if (error.status === 404) return "Not found.";
  if (error.code === "SourceAlreadyLinked") return "That source is already linked to a project.";
  if (error.status === 400) return "The Coordinator rejected that input.";
  return `Coordinator returned ${error.status} (${error.code}).`;
};

/** Typed client for the Coordinator read API. Responses are decoded with the contract schemas. */
export const makeApi = (fetchFn: typeof fetch = fetch) => {
  const send = async <S extends Schema.Decoder<unknown>>(
    path: string,
    schema: S,
    init?: { readonly method: "POST" | "PATCH"; readonly json: unknown },
  ) => {
    const res = await fetchFn(
      `/api${path}`,
      init && {
        method: init.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(init.json),
      },
    );
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, errorCode(body, res));
    return Schema.decodeUnknownSync(schema)(body);
  };
  const get = <S extends Schema.Decoder<unknown>>(path: string, schema: S) => send(path, schema);
  const id = encodeURIComponent;

  return {
    projects: () => get("/projects", Schema.Array(Project)),
    project: (projectId: string) => get(`/projects/${id(projectId)}`, ProjectDetail),
    tickets: (projectId: string) => get(`/projects/${id(projectId)}/tickets`, Schema.Array(Ticket)),
    memory: (projectId: string) =>
      get(`/projects/${id(projectId)}/memory`, Schema.Array(MemoryEntry)),
    ticket: (ticketId: string) => get(`/tickets/${id(ticketId)}`, TicketDetail),
    workers: () => get("/workers", Schema.Array(WorkerView)),
    activity: (since: string | null) =>
      get(since === null ? "/activity" : `/activity?since=${id(since)}`, ActivityFeed),
    updateProject: (projectId: string, patch: ProjectPatch) =>
      send(`/projects/${id(projectId)}`, Project, { method: "PATCH", json: patch }),
    addSource: (projectId: string, source: SourceInput) =>
      send(`/projects/${id(projectId)}/sources`, ProjectSource, { method: "POST", json: source }),
  };
};

export type Api = ReturnType<typeof makeApi>;

export const api = makeApi();
