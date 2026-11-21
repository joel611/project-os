import {
  ActivityFeed,
  type AssignSharedAccount,
  AuditPage,
  type AuditKind,
  type CreateSharedAccount,
  MemberList,
  MemoryEntry,
  MyTickets,
  Project,
  ProjectSource,
  SharedAccountConnect,
  SharedAccountsView,
  Skill,
  SkillCandidates,
  TaskType,
  TaskTypeList,
  SkillUpdateReport,
  Ticket,
  TicketAttachmentsOutput,
  TicketEvent,
  Role,
  Viewer,
  Worker,
  WorkerStatus,
} from "@project-os/contracts";
import { Schema } from "effect";
import type { SourceInput } from "@/model";
import { session, sessionExpired } from "./session.ts";

const WorkerView = Schema.Struct({ ...Worker.fields, status: WorkerStatus });
export type WorkerView = typeof WorkerView.Type;

const WorkerDetail = Schema.Struct({ worker: WorkerView, tickets: Schema.Array(Ticket) });
export type WorkerDetail = typeof WorkerDetail.Type;

const ProjectDetail = Schema.Struct({ project: Project, sources: Schema.Array(ProjectSource) });
export type ProjectDetail = typeof ProjectDetail.Type;

const TicketDetail = Schema.Struct({
  ticket: Ticket,
  events: Schema.Array(TicketEvent),
  /** The task type the request was routed to; null when none, or deleted since. */
  taskType: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type TicketDetail = typeof TicketDetail.Type;

export interface SourcePatch {
  readonly alias?: string;
  readonly description?: string | null;
}

/** Narrows an audit feed; `before` is the previous page's `nextCursor`. */
export interface AuditFilter {
  readonly kind?: AuditKind;
  readonly projectId?: string;
  readonly before?: string;
}

const auditSearch = (query: AuditFilter) => {
  const params = new URLSearchParams();
  if (query.kind) params.set("kind", query.kind);
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.before) params.set("before", query.before);
  const search = params.toString();
  return search ? `?${search}` : "";
};

const Deleted = Schema.Struct({ deleted: Schema.Boolean });
const AddedSkills = Schema.Struct({ skills: Schema.Array(Skill) });

export interface ProjectPatch {
  readonly name?: string;
  readonly customInstructions?: string;
  readonly channelDigest?: boolean;
  readonly channelDigestNotify?: boolean;
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
  if (error.status === 401) return "Your session ended. Sign in again.";
  if (error.status === 403) return "This account isn't allowed to use the dashboard.";
  if (error.status === 404) return "Not found.";
  if (error.status === 501) return "The Coordinator isn't set up for that yet.";
  if (error.code === "SourceAlreadyLinked") return "That source is already linked to a project.";
  if (error.code === "TaskTypeNameTaken") return "A task type with that name already exists.";
  if (error.code === "InvalidTaskType")
    return 'Use a name of 1 to 60 characters, other than "none".';
  if (error.code === "InvalidSkillSource")
    return "Use owner/repo, or a skills.sh or github.com link to a repo.";
  if (error.code === "SkillFetchFailed")
    return "Couldn't read that from GitHub (not found, too large, or rate limited).";
  if (error.status === 400) return "The Coordinator rejected that input.";
  return `Coordinator returned ${error.status} (${error.code}).`;
};

/**
 * Where the API lives. A build with `VITE_COORDINATOR_URL` calls the Coordinator directly
 * (it must allow this origin with CORS). Without it, `/api`, which the Vite dev server proxies.
 */
export const apiBase = (coordinatorUrl: string | undefined): string =>
  coordinatorUrl ? coordinatorUrl.replace(/\/+$/, "") : "/api";

/** How the client gets its session token, and what happens when the Coordinator refuses it. */
export interface ApiSession {
  readonly token: () => string | null;
  /** A 401: the token is missing, expired, or signed out elsewhere. */
  readonly expired: () => void;
}

const browserSession: ApiSession = { token: session.token, expired: sessionExpired };

/** Typed client for the Coordinator read API. Responses are decoded with the contract schemas. */
export const makeApi = (
  fetchFn: typeof fetch = fetch,
  base: string = apiBase(import.meta.env.VITE_COORDINATOR_URL as string | undefined),
  auth: ApiSession = browserSession,
) => {
  const send = async <S extends Schema.Decoder<unknown>>(
    path: string,
    schema: S,
    init?: { readonly method: "POST" | "PATCH" | "DELETE"; readonly json?: unknown },
  ) => {
    const token = auth.token();
    const res = await fetchFn(`${base}${path}`, {
      ...(init && { method: init.method }),
      ...(init?.json !== undefined && { body: JSON.stringify(init.json) }),
      headers: {
        ...(init?.json !== undefined && { "content-type": "application/json" }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 401) auth.expired();
    if (!res.ok) throw new ApiError(res.status, errorCode(body, res));
    return Schema.decodeUnknownSync(schema)(body);
  };
  const get = <S extends Schema.Decoder<unknown>>(path: string, schema: S) => send(path, schema);
  const id = encodeURIComponent;

  return {
    me: () => get("/me", Viewer),
    myTickets: () => get("/me/tickets", MyTickets),
    members: () => get("/members", MemberList),
    setMemberRole: (key: string, role: Role) =>
      send(`/members/${id(key)}/role`, Schema.Struct({ role: Role }), {
        method: "POST",
        json: { role },
      }),
    sharedAccounts: () => get("/shared-accounts", SharedAccountsView),
    addSharedAccount: (input: CreateSharedAccount) =>
      send("/shared-accounts", SharedAccountConnect, { method: "POST", json: input }),
    reconnectSharedAccount: (accountId: string) =>
      send(`/shared-accounts/${id(accountId)}/connect`, SharedAccountConnect, { method: "POST" }),
    removeSharedAccount: (accountId: string) =>
      send(`/shared-accounts/${id(accountId)}`, Schema.Struct({ removed: Schema.Boolean }), {
        method: "DELETE",
      }),
    assignSharedAccount: (input: AssignSharedAccount) =>
      send("/shared-accounts/assignments", Schema.Struct({ ok: Schema.Boolean }), {
        method: "POST",
        json: input,
      }),
    projects: () => get("/projects", Schema.Array(Project)),
    project: (projectId: string) => get(`/projects/${id(projectId)}`, ProjectDetail),
    tickets: (projectId: string) => get(`/projects/${id(projectId)}/tickets`, Schema.Array(Ticket)),
    memory: (projectId: string) =>
      get(`/projects/${id(projectId)}/memory`, Schema.Array(MemoryEntry)),
    audit: (query: AuditFilter = {}) => get(`/audit${auditSearch(query)}`, AuditPage),
    projectAudit: (projectId: string, query: Omit<AuditFilter, "projectId"> = {}) =>
      get(`/projects/${id(projectId)}/audit${auditSearch(query)}`, AuditPage),
    ticket: (ticketId: string) => get(`/tickets/${id(ticketId)}`, TicketDetail),
    ticketAttachments: (ticketId: string) =>
      get(`/tickets/${id(ticketId)}/attachments`, TicketAttachmentsOutput),
    workers: () => get("/workers", Schema.Array(WorkerView)),
    worker: (workerId: string) => get(`/workers/${id(workerId)}`, WorkerDetail),
    workerAudit: (workerId: string, query: Omit<AuditFilter, "projectId"> = {}) =>
      get(`/workers/${id(workerId)}/audit${auditSearch(query)}`, AuditPage),
    assignTicket: (ticketId: string, workerId: string) =>
      send(`/tickets/${id(ticketId)}/assign`, Ticket, { method: "POST", json: { workerId } }),
    taskTypes: () => get("/task-types", TaskTypeList),
    createTaskType: (input: { name: string; description: string; instructions?: string }) =>
      send("/task-types", TaskType, { method: "POST", json: input }),
    updateTaskType: (
      setId: string,
      patch: { name?: string; description?: string; instructions?: string },
    ) => send(`/task-types/${id(setId)}`, TaskType, { method: "PATCH", json: patch }),
    deleteTaskType: (setId: string) =>
      send(`/task-types/${id(setId)}`, Deleted, { method: "DELETE" }),
    browseSkills: (source: string) =>
      send("/task-types/browse", SkillCandidates, { method: "POST", json: { source } }),
    addSkills: (setId: string, input: { source: string; slugs: readonly string[] }) =>
      send(`/task-types/${id(setId)}/skills`, AddedSkills, { method: "POST", json: input }),
    removeSkill: (setId: string, skillId: string) =>
      send(`/task-types/${id(setId)}/skills/${id(skillId)}`, Deleted, { method: "DELETE" }),
    skillUpdates: (setId: string) => get(`/task-types/${id(setId)}/updates`, SkillUpdateReport),
    updateSkills: (setId: string, skillIds?: readonly string[]) =>
      send(`/task-types/${id(setId)}/update`, AddedSkills, {
        method: "POST",
        json: skillIds ? { skillIds } : {},
      }),
    activity: (since: string | null) =>
      get(since === null ? "/activity" : `/activity?since=${id(since)}`, ActivityFeed),
    updateProject: (projectId: string, patch: ProjectPatch) =>
      send(`/projects/${id(projectId)}`, Project, { method: "PATCH", json: patch }),
    addSource: (projectId: string, source: SourceInput) =>
      send(`/projects/${id(projectId)}/sources`, ProjectSource, { method: "POST", json: source }),
    updateSource: (projectId: string, sourceId: string, patch: SourcePatch) =>
      send(`/projects/${id(projectId)}/sources/${id(sourceId)}`, ProjectSource, {
        method: "PATCH",
        json: patch,
      }),
    removeSource: (projectId: string, sourceId: string) =>
      send(`/projects/${id(projectId)}/sources/${id(sourceId)}`, ProjectSource, {
        method: "DELETE",
      }),
  };
};

export type Api = ReturnType<typeof makeApi>;

export const api = makeApi();
