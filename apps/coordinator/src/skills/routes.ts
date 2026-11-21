import { authenticateCaller, skillArchiveForTicket, taskTypeForTicket } from "@project-os/core";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { bearerToken } from "../access.ts";
import type { McpRuntime } from "../mcp/server.ts";

/**
 * `GET /tickets/:id/task-type`: the ticket's task type name and instructions as JSON (204 when it
 * has none), for the Worker's system prompt. Same auth as the skills below.
 * `GET /tickets/:id/skills`: a zip of the skills a Worker unpacks before it starts its ticket
 * (entries `<slug>/<path>`; 204 when the ticket has none). The
 * caller proves who it is with the MCP Bearer it already holds (a Watcher's secret or a sandbox
 * session's token), and only the ticket's own worker may read them.
 */
export const skillRoutes = (deps: { readonly runtime: McpRuntime }) =>
  new Elysia({ name: "skills" })
    .get("/tickets/:id/task-type", async ({ params, request, set }) => {
      const token = bearerToken(request);
      const caller = token ? await deps.runtime.runPromise(authenticateCaller(token)) : undefined;
      if (!caller) {
        set.status = 401;
        return { error: "Unauthorized", message: "Send your MCP token as a Bearer token." };
      }
      const outcome = await deps.runtime.runPromise(
        taskTypeForTicket(params.id, caller).pipe(
          Effect.map((taskType) => ({ ok: true as const, taskType })),
          Effect.catch((e: { _tag: string; message?: string }) =>
            Effect.succeed({ ok: false as const, tag: e._tag, message: e.message || e._tag }),
          ),
        ),
      );
      if (outcome.ok) {
        if (!outcome.taskType) {
          set.status = 204;
          return;
        }
        return outcome.taskType;
      }
      set.status = outcome.tag === "TicketNotFound" ? 404 : 403;
      return { error: outcome.tag, message: outcome.message };
    })
    .get("/tickets/:id/skills", async ({ params, request, set }) => {
      const token = bearerToken(request);
      const caller = token ? await deps.runtime.runPromise(authenticateCaller(token)) : undefined;
      if (!caller) {
        set.status = 401;
        return { error: "Unauthorized", message: "Send your MCP token as a Bearer token." };
      }
      const outcome = await deps.runtime.runPromise(
        skillArchiveForTicket(params.id, caller).pipe(
          Effect.map((bundle) => ({ ok: true as const, bundle })),
          Effect.catch((e: { _tag: string; message?: string }) =>
            Effect.succeed({ ok: false as const, tag: e._tag, message: e.message || e._tag }),
          ),
        ),
      );
      if (outcome.ok) {
        const { set: taskType, archive } = outcome.bundle;
        if (!taskType || !archive) {
          set.status = 204;
          return;
        }
        return new Response(archive, {
          headers: {
            "content-type": "application/zip",
            "x-task-type": encodeURIComponent(taskType.name),
          },
        });
      }
      set.status =
        outcome.tag === "TicketNotFound" ? 404 : outcome.tag === "SkillFetchFailed" ? 502 : 403;
      return { error: outcome.tag, message: outcome.message };
    });
