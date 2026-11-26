import { TASK_TYPE_HEADER, WORKER_TICKET_ROUTES } from "@project-os/contracts";
import { skillArchiveForTicket, taskTypeForTicket } from "@project-os/core";
import { Elysia } from "elysia";
import type { McpRuntime } from "../mcp/server.ts";
import { asWorker, runForWorker, type TicketRequest } from "../worker-access.ts";

/**
 * `GET /tickets/:id/task-type`: the ticket's task type name and instructions as JSON (204 when it
 * has none), for the Worker's system prompt. Same auth as the skills below.
 * `GET /tickets/:id/skills`: a zip of the skills a Worker unpacks before it starts its ticket
 * (entries `<slug>/<path>`; 204 when the ticket has none). Both are `worker` routes, and only
 * the ticket's own worker may read them.
 */
export const skillRoutes = (deps: { readonly runtime: McpRuntime }) =>
  new Elysia({ name: "skills" })
    .get(
      WORKER_TICKET_ROUTES.taskType,
      asWorker(deps.runtime, async ({ params, set }: TicketRequest, caller) => {
        const outcome = await runForWorker(deps.runtime, taskTypeForTicket(params.id, caller));
        if (!outcome.ok) {
          set.status = outcome.status;
          return outcome.body;
        }
        if (!outcome.value) {
          set.status = 204;
          return;
        }
        return outcome.value;
      }),
    )
    .get(
      WORKER_TICKET_ROUTES.skills,
      asWorker(deps.runtime, async ({ params, set }: TicketRequest, caller) => {
        const outcome = await runForWorker(deps.runtime, skillArchiveForTicket(params.id, caller));
        if (!outcome.ok) {
          set.status = outcome.status;
          return outcome.body;
        }
        const { set: taskType, archive } = outcome.value;
        if (!taskType || !archive) {
          set.status = 204;
          return;
        }
        return new Response(archive, {
          headers: {
            "content-type": "application/zip",
            [TASK_TYPE_HEADER]: encodeURIComponent(taskType.name),
          },
        });
      }),
    );
