import { Option, Schema } from "effect";

/**
 * The per-ticket HTTP routes beside `/mcp`: what the Coordinator mounts and what a Watcher or a
 * sandbox session calls, with the same Bearer token it calls MCP with. Deployed Watchers and
 * sandboxes depend on these paths and shapes. A run upload's shapes are in runs.ts.
 */
export const WORKER_RUN_SIGNAL_ROUTE = "/tickets/:id/runs/:runId/signal";

export const WORKER_TICKET_ROUTES = {
  /** A zip of the ticket's skills, entries `<slug>/<path>`; 204 when it has none. */
  skills: "/tickets/:id/skills",
  /** The ticket's task type (`WorkerTaskType`); 204 when it has none. */
  taskType: "/tickets/:id/task-type",
  /** Takes a `RunUpload`. */
  runs: "/tickets/:id/runs",
} as const;

/** Where a Worker calls one of `WORKER_TICKET_ROUTES`: next to the Coordinator's MCP endpoint. */
export const workerTicketUrl = (
  mcpUrl: string,
  route: keyof typeof WORKER_TICKET_ROUTES,
  ticketId: string,
): string =>
  `${mcpUrl.replace(/\/mcp\/?$/, "")}${WORKER_TICKET_ROUTES[route].replace(":id", encodeURIComponent(ticketId))}`;

/** On the skill zip's response: the task type's name, `encodeURIComponent`-encoded. */
export const TASK_TYPE_HEADER = "x-task-type";

/**
 * What a Worker reads of the task type: the name, and the instructions for its system prompt. The
 * Coordinator also sends `id`, which a Worker doesn't need.
 */
export const WorkerTaskType = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
});
export type WorkerTaskType = typeof WorkerTaskType.Type;

const decodeTaskType = Schema.decodeUnknownOption(WorkerTaskType);

/** `body` as a `WorkerTaskType`, without any other keys; undefined when it isn't one. */
export const decodeWorkerTaskType = (body: unknown): WorkerTaskType | undefined =>
  Option.getOrUndefined(decodeTaskType(body));
