import { RunUpload } from "@project-os/contracts";
import { authenticateCaller, ingestRun } from "@project-os/core";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";
import { bearerToken } from "../access.ts";
import { toResult } from "../http/result.ts";
import type { McpRuntime } from "../mcp/server.ts";

const decodeUpload = Schema.decodeUnknownOption(RunUpload);

/**
 * `POST /tickets/:id/runs`: a Worker's session log, uploaded in numbered chunks (the shape is
 * `RunUpload`). The caller proves who it is with the MCP Bearer it already holds, and only the
 * ticket's own worker may write to it. 409 with `expected` when a chunk skips ahead.
 */
export const runRoutes = (deps: { readonly runtime: McpRuntime }) =>
  new Elysia({ name: "runs" }).post("/tickets/:id/runs", async ({ params, request, body, set }) => {
    const token = bearerToken(request);
    const caller = token ? await deps.runtime.runPromise(authenticateCaller(token)) : undefined;
    if (!caller) {
      set.status = 401;
      return { error: "Unauthorized", message: "Send your MCP token as a Bearer token." };
    }
    const upload = decodeUpload(body);
    if (upload._tag === "None") {
      set.status = 400;
      return { error: "SchemaError", message: "The body is not a run upload." };
    }
    const result = await deps.runtime.runPromise(
      toResult(
        ingestRun(params.id, caller, upload.value).pipe(
          Effect.map((run) => ({
            runId: run.id,
            nextSeq: run.nextSeq,
            truncated: run.truncated,
            status: run.status,
          })),
          // The uploader needs the number, not a sentence, to catch up.
          Effect.catchTag("RunOutOfOrder", (e) =>
            Effect.succeed({ outOfOrder: true as const, expected: e.expected }),
          ),
        ),
      ),
    );
    const answer = result.body as { outOfOrder?: true; expected?: number };
    if (answer.outOfOrder) {
      set.status = 409;
      return { error: "RunOutOfOrder", expected: answer.expected };
    }
    set.status = result.status;
    return result.body;
  });
