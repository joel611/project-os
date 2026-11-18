import { authenticateCaller, skillBundleForTicket } from "@project-os/core";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { bearerToken } from "../access.ts";
import type { McpRuntime } from "../mcp/server.ts";

/**
 * `GET /tickets/:id/skills`: the skill files a Worker installs before it starts its ticket. The
 * caller proves who it is with the MCP Bearer it already holds (a Watcher's secret or a sandbox
 * session's token), and only the ticket's own worker may read them.
 */
export const skillRoutes = (deps: { readonly runtime: McpRuntime }) =>
  new Elysia({ name: "skills" }).get("/tickets/:id/skills", async ({ params, request, set }) => {
    const token = bearerToken(request);
    const caller = token ? await deps.runtime.runPromise(authenticateCaller(token)) : undefined;
    if (!caller) {
      set.status = 401;
      return { error: "Unauthorized", message: "Send your MCP token as a Bearer token." };
    }
    const outcome = await deps.runtime.runPromise(
      skillBundleForTicket(params.id, caller).pipe(
        Effect.map((bundle) => ({ ok: true as const, bundle })),
        Effect.catch((e: { _tag: string; message?: string }) =>
          Effect.succeed({ ok: false as const, tag: e._tag, message: e.message || e._tag }),
        ),
      ),
    );
    if (outcome.ok) return outcome.bundle;
    set.status = outcome.tag === "TicketNotFound" ? 404 : 403;
    return { error: outcome.tag, message: outcome.message };
  });
