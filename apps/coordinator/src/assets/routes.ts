import {
  AssetStore,
  completeAttachmentUpload,
  DEFAULT_MAX_ATTACHMENT_BYTES,
} from "@project-os/core";
import { Effect } from "effect";
import { Elysia } from "elysia";
import type { McpServices } from "../mcp/tools.ts";

export interface AssetDeps {
  /** Runs an effect against the provider Layer chosen by the entry file. */
  readonly run: <A>(effect: Effect.Effect<A, never, McpServices>) => Promise<A>;
}

/**
 * Types a browser may show in place. SVG, HTML and the rest are always downloads, since opened
 * from this origin they could run script.
 */
const INLINE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

/**
 * Downloads for files people attached to a request. The signature in the link is the only
 * credential, so a Worker can fetch with a plain GET; it covers one file and expires.
 */
export const assetRoutes = ({ run }: AssetDeps) =>
  new Elysia({ name: "asset-routes" })
    .get("/assets/:ticketId/:attachmentId/:filename", async ({ params, query, set }) => {
      const key = `${params.ticketId}/${params.attachmentId}/${params.filename}`;
      const expires = Number(query.exp);
      const outcome = await run(
        Effect.gen(function* () {
          const store = yield* AssetStore;
          if (!Number.isFinite(expires) || !(yield* store.verify(key, expires, query.sig ?? ""))) {
            return "forbidden" as const;
          }
          return yield* store
            .get(key)
            .pipe(Effect.catchTag("AssetStoreFailed", () => Effect.succeed("failed" as const)));
        }),
      );
      if (outcome === "forbidden") {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (outcome === "failed") {
        set.status = 502;
        return { error: "The file could not be read." };
      }
      if (outcome === undefined) {
        set.status = 404;
        return { error: "Not found" };
      }
      return new Response(outcome.body, {
        headers: {
          "content-type": outcome.contentType,
          "content-length": String(outcome.size),
          // Stored bytes are someone else's file: only plain raster images are shown in place
          // (the dashboard's <img>); anything else is saved, never rendered in this origin.
          "content-disposition": `${INLINE_TYPES.test(outcome.contentType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(params.filename)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    })
    .put(
      "/assets/:ticketId/:attachmentId/:filename",
      async ({ params, query, request, set }) => {
        const key = `${params.ticketId}/${params.attachmentId}/${params.filename}`;
        const expires = Number(query.exp);
        const size = Number(request.headers.get("content-length"));
        if (!Number.isInteger(size) || size <= 0) {
          set.status = 411;
          return { error: "Send the file with a content-length header (curl -T does)." };
        }
        if (size > DEFAULT_MAX_ATTACHMENT_BYTES) {
          set.status = 413;
          return { error: `The file is bigger than ${DEFAULT_MAX_ATTACHMENT_BYTES} bytes.` };
        }
        const outcome = await run(
          Effect.gen(function* () {
            const store = yield* AssetStore;
            if (
              !Number.isFinite(expires) ||
              !(yield* store.verifyUpload(key, expires, query.sig ?? ""))
            ) {
              return "forbidden" as const;
            }
            if (request.body === null) return "empty" as const;
            return yield* completeAttachmentUpload({
              ticketId: params.ticketId,
              attachmentId: params.attachmentId,
              filename: params.filename,
              contentType: request.headers.get("content-type") ?? "application/octet-stream",
              size,
              body: request.body,
            }).pipe(
              Effect.map(() => "stored" as const),
              Effect.catch(() => Effect.succeed("failed" as const)),
            );
          }),
        );
        if (outcome === "forbidden") {
          set.status = 403;
          return { error: "Forbidden" };
        }
        if (outcome === "empty") {
          set.status = 411;
          return { error: "No file in the request body." };
        }
        if (outcome === "failed") {
          set.status = 502;
          return { error: "The file could not be stored." };
        }
        return { ok: true };
      },
      { parse: "none" },
    );
