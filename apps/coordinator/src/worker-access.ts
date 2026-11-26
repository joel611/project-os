import { authenticateCaller, type McpCaller } from "@project-os/core";
import { Effect } from "effect";
import { bearerToken } from "./access.ts";
import type { McpRuntime } from "./mcp/server.ts";
import type { McpServices } from "./mcp/tools.ts";

/**
 * Worker HTTP access (the `worker` route policy): the one place a Watcher's secret or a sandbox
 * session's token is authenticated. The app guard runs `refuseNonWorker` in front of every
 * `worker` route, and `asWorker` is how its handler gets the caller; the two share one lookup
 * per request. Whether the caller may act on a given Ticket is core's decision, not this one's.
 */

/** What admission reads of a request's context. */
export interface WorkerRequest {
  readonly request: Request;
  /** The matched route pattern, e.g. `/tickets/:id/runs`. */
  readonly route: string;
  readonly set: { status?: number | string };
}

/** A per-ticket route's context (`WORKER_TICKET_ROUTES`). */
export interface TicketRequest extends WorkerRequest {
  readonly params: { readonly id: string };
}

const seen = new WeakMap<Request, Promise<McpCaller | undefined>>();

const workerCaller = (runtime: McpRuntime, request: Request): Promise<McpCaller | undefined> => {
  let found = seen.get(request);
  if (!found) {
    const token = bearerToken(request);
    found = token ? runtime.runPromise(authenticateCaller(token)) : Promise.resolve(undefined);
    seen.set(request, found);
  }
  return found;
};

const unauthorized = () => ({
  error: "Unauthorized",
  message: "Send your MCP token as a Bearer token.",
});

/** The 401 each route has always sent: deployed Watchers and sandboxes read these. */
const refusal = ({ route, set }: WorkerRequest) => {
  if (route === "/mcp") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (route === "/egress/:service/*") return Response.json(unauthorized(), { status: 401 });
  set.status = 401;
  return unauthorized();
};

/**
 * For the app guard: the refusal to send, or undefined for a valid Worker. With no runtime to
 * check credentials against, everyone is refused.
 */
export const refuseNonWorker = async (runtime: McpRuntime | undefined, context: WorkerRequest) =>
  runtime && (await workerCaller(runtime, context.request)) ? undefined : refusal(context);

/** A `worker` route's handler: `handle` runs only for a valid Worker, and is given who it is. */
export const asWorker =
  <Context extends WorkerRequest, Result>(
    runtime: McpRuntime,
    handle: (context: Context, caller: McpCaller) => Result,
  ) =>
  async (context: Context) => {
    const caller = await workerCaller(runtime, context.request);
    return caller ? handle(context, caller) : refusal(context);
  };

/** Statuses of the typed failures a Worker can get; any other is a 403. */
const FAILURE_STATUS: Readonly<Record<string, number>> = {
  TicketNotFound: 404,
  SkillFetchFailed: 502,
};

/** Runs a Worker's core call. A typed failure comes back as its status and `{ error, message }`. */
export const runForWorker = <A, E extends { readonly _tag: string; readonly message?: string }>(
  runtime: McpRuntime,
  effect: Effect.Effect<A, E, McpServices>,
) =>
  runtime.runPromise(
    effect.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((e) =>
        Effect.succeed({
          ok: false as const,
          status: FAILURE_STATUS[e._tag] ?? 403,
          body: { error: e._tag, message: e.message || e._tag },
        }),
      ),
    ),
  );
