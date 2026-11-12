import {
  type AttachmentStorageConfig,
  completeAttachmentUpload,
  readAttachmentFile,
} from "@project-os/core";
import { Effect } from "effect";
import { Elysia } from "elysia";
import type { McpServices } from "../mcp/tools.ts";

export interface AssetDeps {
  readonly run: <A>(effect: Effect.Effect<A, never, McpServices>) => Promise<A>;
  /** Storage limits; `maxBytes` is the largest upload accepted. */
  readonly attachments?: AttachmentStorageConfig;
}

const INLINE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

const refuse = (status: number, error: string) => Effect.succeed({ status, error });

/**
 * Downloads for files people attached to a request, and uploads for files Workers send back. The
 * signature in the link is the only credential, so a Worker can use a plain GET or PUT; it covers
 * one file and expires. Each typed error from the Attachments module maps to its own status.
 */
export const assetRoutes = ({ run, attachments }: AssetDeps) =>
  new Elysia({ name: "asset-routes" })
    .get("/assets/:ticketId/:attachmentId/:filename", async ({ params, query, set }) => {
      const outcome = await run(
        readAttachmentFile(params, { expires: Number(query.exp), sig: query.sig ?? "" }).pipe(
          Effect.catchTags({
            AssetLinkInvalid: () => refuse(403, "Forbidden"),
            AssetNotFound: () => refuse(404, "Not found"),
            AssetStoreFailed: () => refuse(502, "The file could not be read."),
          }),
        ),
      );
      if ("status" in outcome) {
        set.status = outcome.status;
        return { error: outcome.error };
      }
      return new Response(outcome.body, {
        headers: {
          "content-type": outcome.contentType,
          "content-length": String(outcome.size),
          "content-disposition": `${INLINE_TYPES.test(outcome.contentType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(params.filename)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    })
    .put(
      "/assets/:ticketId/:attachmentId/:filename",
      async ({ params, query, request, set }) => {
        const size = Number(request.headers.get("content-length"));
        if (!Number.isInteger(size) || size <= 0 || request.body === null) {
          set.status = 411;
          return { error: "Send the file with a content-length header (curl -T does)." };
        }
        const outcome = await run(
          completeAttachmentUpload(
            {
              ...params,
              expires: Number(query.exp),
              sig: query.sig ?? "",
              contentType: request.headers.get("content-type") ?? "application/octet-stream",
              size,
              body: request.body,
            },
            attachments,
          ).pipe(
            Effect.as(undefined),
            Effect.catchTags({
              AssetLinkInvalid: () => refuse(403, "Forbidden"),
              AttachmentTooLarge: ({ maxBytes }) =>
                refuse(413, `The file is bigger than ${maxBytes} bytes.`),
              TicketNotFound: () => refuse(404, "Ticket not found."),
              AssetStoreFailed: () => refuse(502, "The file could not be stored."),
            }),
          ),
        );
        if (outcome !== undefined) {
          set.status = outcome.status;
          return { error: outcome.error };
        }
        return { ok: true };
      },
      { parse: "none" },
    );
