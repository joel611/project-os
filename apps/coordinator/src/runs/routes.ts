import {
  RunUpload,
  type RunUploadAccepted,
  type RunUploadOutOfOrder,
  WORKER_TICKET_ROUTES,
} from "@project-os/contracts";
import { ingestRun } from "@project-os/core";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";
import { type HttpResult, toResult } from "../http/result.ts";
import type { McpRuntime } from "../mcp/server.ts";
import { asWorker, type TicketRequest } from "../worker-access.ts";

const decodeUpload = Schema.decodeUnknownOption(RunUpload);

type UploadRequest = TicketRequest & { readonly body: unknown };

/**
 * `POST /tickets/:id/runs`: a Worker's session log, uploaded in numbered chunks (the shape is
 * `RunUpload`). A `worker` route, and only the ticket's own worker may write to it. 409 with
 * `expected` when a chunk skips ahead.
 */
export const runRoutes = (deps: { readonly runtime: McpRuntime }) =>
  new Elysia({ name: "runs" }).post(
    WORKER_TICKET_ROUTES.runs,
    asWorker(deps.runtime, async ({ params, body, set }: UploadRequest, caller) => {
      const upload = decodeUpload(body);
      if (upload._tag === "None") {
        set.status = 400;
        return { error: "SchemaError", message: "The body is not a run upload." };
      }
      const result = await deps.runtime.runPromise(
        ingestRun(params.id, caller, upload.value).pipe(
          Effect.map((run): HttpResult => {
            const accepted: RunUploadAccepted = {
              runId: run.id,
              nextSeq: run.nextSeq,
              truncated: run.truncated,
              status: run.status,
            };
            return { status: 200, body: accepted };
          }),
          // The uploader needs the number, not a sentence, to catch up.
          Effect.catchTag("RunOutOfOrder", (e) => {
            const body: RunUploadOutOfOrder = { error: "RunOutOfOrder", expected: e.expected };
            return Effect.succeed<HttpResult>({ status: 409, body });
          }),
          // Every other failure answers as the dashboard routes do: `{ error, detail }`.
          Effect.catch((e) => toResult(Effect.fail(e))),
        ),
      );
      set.status = result.status;
      return result.body;
    }),
  );
