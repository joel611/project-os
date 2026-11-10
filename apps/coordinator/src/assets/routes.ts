import { AssetStore } from "@project-os/core";
import { Effect } from "effect";
import { Elysia } from "elysia";

export interface AssetDeps {
  /** Runs an effect against the provider Layer chosen by the entry file. */
  readonly run: <A>(effect: Effect.Effect<A, never, AssetStore>) => Promise<A>;
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
  new Elysia({ name: "asset-routes" }).get(
    "/assets/:ticketId/:attachmentId/:filename",
    async ({ params, query, set }) => {
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
    },
  );
