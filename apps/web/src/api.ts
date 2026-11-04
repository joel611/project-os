import {
  MemoryEntry,
  Project,
  ProjectSource,
  Ticket,
  TicketEvent,
  Worker,
  WorkerStatus,
} from "@project-os/contracts";
import { Schema } from "effect";

const WorkerView = Schema.Struct({ ...Worker.fields, status: WorkerStatus });
export type WorkerView = typeof WorkerView.Type;

const ProjectDetail = Schema.Struct({ project: Project, sources: Schema.Array(ProjectSource) });
export type ProjectDetail = typeof ProjectDetail.Type;

const TicketDetail = Schema.Struct({ ticket: Ticket, events: Schema.Array(TicketEvent) });
export type TicketDetail = typeof TicketDetail.Type;

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

/** Typed client for the Coordinator read API. Responses are decoded with the contract schemas. */
export const makeApi = (fetchFn: typeof fetch = fetch) => {
  const get = async <S extends Schema.Decoder<unknown>>(path: string, schema: S) => {
    const res = await fetchFn(`/api${path}`);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, errorCode(body, res));
    return Schema.decodeUnknownSync(schema)(body);
  };
  const id = encodeURIComponent;

  return {
    projects: () => get("/projects", Schema.Array(Project)),
    project: (projectId: string) => get(`/projects/${id(projectId)}`, ProjectDetail),
    tickets: (projectId: string) => get(`/projects/${id(projectId)}/tickets`, Schema.Array(Ticket)),
    memory: (projectId: string) =>
      get(`/projects/${id(projectId)}/memory`, Schema.Array(MemoryEntry)),
    ticket: (ticketId: string) => get(`/tickets/${id(ticketId)}`, TicketDetail),
    workers: () => get("/workers", Schema.Array(WorkerView)),
  };
};

export type Api = ReturnType<typeof makeApi>;
