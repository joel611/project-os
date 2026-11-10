import { makeAssetStore } from "@project-os/infra-local/shared";
import { Effect } from "effect";
import { makeR2Backend } from "../../../../packages/infra-cloudflare/src/r2.ts";

// A minimal Worker around the real R2 backend and AssetStore, so ../r2-assets.test.ts can run
// them in workerd: ingest a file from a fake CDN into R2, read it back, mint and check links.

interface Env {
  readonly ASSETS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    const store = makeAssetStore({
      backend: makeR2Backend(env.ASSETS),
      links: { publicUrl: "https://coordinator.test", secret: "r2-test-secret" },
      fetch: (cdnUrl) => fetch(cdnUrl),
    });
    if (url.pathname === "/ingest") {
      const result = await Effect.runPromise(
        Effect.result(
          store.ingest({
            key,
            url: "https://cdn.test/file",
            contentType: url.searchParams.get("type"),
            size: Number(url.searchParams.get("size")),
            maxBytes: Number(url.searchParams.get("max") ?? 1_000_000),
          }),
        ),
      );
      return Response.json(
        result._tag === "Success" ? { ok: true } : { ok: false, message: result.failure.message },
      );
    }
    if (url.pathname === "/get") {
      const found = await Effect.runPromise(store.get(key).pipe(Effect.orDie));
      if (!found) return new Response("missing", { status: 404 });
      return new Response(found.body, {
        headers: { "content-type": found.contentType, "x-size": String(found.size) },
      });
    }
    if (url.pathname === "/link") {
      const link = await Effect.runPromise(store.link(key));
      const exp = Number(new URL(link!).searchParams.get("exp"));
      const sig = new URL(link!).searchParams.get("sig")!;
      return Response.json({ link, valid: await Effect.runPromise(store.verify(key, exp, sig)) });
    }
    return new Response("not found", { status: 404 });
  },
};
