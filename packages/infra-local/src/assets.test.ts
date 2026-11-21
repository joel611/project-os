import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "@project-os/core";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AssetStoreUnavailable, type BlobBackend, makeAssetStore } from "./assets.ts";
import { makeDiskBackend } from "./assets-disk.ts";

const bytesOf = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());
const memoryBackend = () => {
  const files = new Map<string, { bytes: Uint8Array; contentType: string; size: number }>();
  const backend: BlobBackend = {
    put: async (key, body, meta) => {
      files.set(key, { bytes: await bytesOf(body), ...meta });
    },
    remove: async (key) => {
      files.delete(key);
    },
    get: async (key) => {
      const file = files.get(key);
      return (
        file && {
          body: new Response(file.bytes).body!,
          contentType: file.contentType,
          size: file.size,
        }
      );
    },
  };
  return { files, backend };
};
const ok =
  (text: string, headers: Record<string, string> = {}) =>
  async () =>
    new Response(text, { headers });
const ingest = (
  store: typeof AssetStore.Service,
  over: { size?: number; maxBytes?: number; url?: string } = {},
) =>
  Effect.runPromise(
    Effect.result(
      store.ingest({
        key: "t1/a1/hero.png",
        url: over.url ?? "http://cdn/hero.png",
        contentType: null,
        size: over.size ?? 5,
        maxBytes: over.maxBytes ?? 100,
      }),
    ),
  );

describe("makeAssetStore", () => {
  it("streams the download into the backend, taking the type from the response when unknown", async () => {
    const { files, backend } = memoryBackend();
    const store = makeAssetStore({
      backend,
      fetch: ok("hello", { "content-type": "image/png" }),
    });
    expect((await ingest(store))._tag).toBe("Success");
    expect(files.get("t1/a1/hero.png")).toMatchObject({ contentType: "image/png", size: 5 });
    const found = await Effect.runPromise(store.get("t1/a1/hero.png"));
    expect(new TextDecoder().decode(await bytesOf(found!.body))).toBe("hello");
  });

  it("falls back to a generic type, and reads missing keys as undefined", async () => {
    const { files, backend } = memoryBackend();
    const store = makeAssetStore({
      backend,
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: {} }),
    });
    await ingest(store, { size: 3 });
    expect(files.get("t1/a1/hero.png")?.contentType).toBe("application/octet-stream");
    expect(await Effect.runPromise(store.get("nope"))).toBeUndefined();
  });

  it("fails when the download is refused or has no body", async () => {
    const { backend } = memoryBackend();
    const refused = makeAssetStore({
      backend,
      fetch: async () => new Response("no", { status: 404 }),
    });
    expect(await ingest(refused)).toMatchObject({
      failure: { _tag: "AssetStoreFailed", message: "download refused (404)" },
    });
    const empty = makeAssetStore({ backend, fetch: async () => new Response(null) });
    expect((await ingest(empty))._tag).toBe("Failure");
  });

  it("cuts a download off at the byte limit, whatever the headers claim", async () => {
    const { files, backend } = memoryBackend();
    const store = makeAssetStore({ backend, fetch: ok("0123456789") });
    expect(await ingest(store, { size: 2, maxBytes: 4 })).toMatchObject({
      failure: { message: "file is bigger than 4 bytes" },
    });
    expect(files.size).toBe(0);
  });

  it("reports a backend failure that is not an Error", async () => {
    const store = makeAssetStore({
      backend: {
        put: async () => {
          throw "bucket gone";
        },
        get: async () => {
          throw new Error("read failed");
        },
        remove: async () => {},
      },
      fetch: ok("hello"),
    });
    expect(await ingest(store)).toMatchObject({ failure: { message: "bucket gone" } });
    expect(await Effect.runPromise(Effect.result(store.get("k")))).toMatchObject({
      failure: { message: "read failed" },
    });
  });

  it("removes a stored file, and reports a backend failure", async () => {
    const { files, backend } = memoryBackend();
    const store = makeAssetStore({ backend });
    files.set("k", { bytes: new Uint8Array([1]), contentType: "text/plain", size: 1 });
    await Effect.runPromise(store.remove("k"));
    expect(files.has("k")).toBe(false);
    const broken = makeAssetStore({
      backend: {
        ...backend,
        remove: async () => {
          throw new Error("bucket gone");
        },
      },
    });
    expect(await Effect.runPromise(Effect.result(broken.remove("k")))).toMatchObject({
      failure: { message: "bucket gone" },
    });
  });

  it("does not follow a redirect off the allowed host", async () => {
    const { files, backend } = memoryBackend();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, { status: 302, headers: { location: "http://elsewhere.test/" } }),
    });
    try {
      const result = await ingest(makeAssetStore({ backend }), {
        url: `http://localhost:${server.port}/`,
      });
      expect(result).toMatchObject({ failure: { message: "download refused (302)" } });
      expect(files.size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  it("uses the global fetch when none is given", async () => {
    const { backend } = memoryBackend();
    const server = Bun.serve({ port: 0, fetch: () => new Response("served") });
    try {
      const store = makeAssetStore({ backend });
      const result = await Effect.runPromise(
        Effect.result(
          store.ingest({
            key: "k",
            url: `http://localhost:${server.port}/`,
            contentType: "text/plain",
            size: 6,
            maxBytes: 100,
          }),
        ),
      );
      expect(result._tag).toBe("Success");
    } finally {
      await server.stop(true);
    }
  });
});

describe("signed links", () => {
  const { backend } = memoryBackend();
  let now = 1_000_000;
  const store = makeAssetStore({
    backend,
    links: {
      publicUrl: "https://coord.example/",
      secret: "s3cret",
      ttlSeconds: 60,
      now: () => now,
    },
  });
  const parts = async (key: string) => {
    const url = new URL((await Effect.runPromise(store.link(key)))!);
    return { url, exp: Number(url.searchParams.get("exp")), sig: url.searchParams.get("sig")! };
  };

  it("points at /assets with the key path-encoded and an expiry", async () => {
    const { url, exp } = await parts("t1/a1/my file.png");
    expect(url.origin + url.pathname).toBe("https://coord.example/assets/t1/a1/my%20file.png");
    expect(exp).toBe(1000 + 60);
  });

  it("verifies until the expiry and refuses a wrong key, expiry, or signature", async () => {
    const { exp, sig } = await parts("t1/a1/hero.png");
    const verify = (key: string, e: number, s: string) =>
      Effect.runPromise(store.verify(key, e, s));
    expect(await verify("t1/a1/hero.png", exp, sig)).toBe(true);
    expect(await verify("t1/a1/other.png", exp, sig)).toBe(false);
    expect(await verify("t1/a1/hero.png", exp + 1, sig)).toBe(false);
    expect(await verify("t1/a1/hero.png", exp, sig.replace(/^./, "x"))).toBe(false);
    expect(await verify("t1/a1/hero.png", exp, sig.slice(1))).toBe(false);
    now = (exp + 1) * 1000;
    expect(await verify("t1/a1/hero.png", exp, sig)).toBe(false);
  });

  it("issues no links and accepts no signatures without a secret", async () => {
    const bare = makeAssetStore({ backend });
    expect(await Effect.runPromise(bare.link("k"))).toBeUndefined();
    expect(await Effect.runPromise(bare.verify("k", 9_999_999_999, "sig"))).toBe(false);
  });

  it("signs uploads separately: an upload link can't download and a download link can't upload", async () => {
    const up = new URL((await Effect.runPromise(store.uploadLink("t1/a1/hero.png")))!.url);
    const exp = Number(up.searchParams.get("exp"));
    const sig = up.searchParams.get("sig")!;
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);
    now = 1_000_000;
    expect(await run(store.verifyUpload("t1/a1/hero.png", exp, sig))).toBe(true);
    expect(await run(store.verify("t1/a1/hero.png", exp, sig))).toBe(false);
    const down = (await parts("t1/a1/hero.png")).sig;
    expect(await run(store.verifyUpload("t1/a1/hero.png", exp, down))).toBe(false);
  });

  it("issues no upload links and refuses upload signatures without a secret", async () => {
    const bare = makeAssetStore({ backend });
    expect(await Effect.runPromise(bare.uploadLink("k"))).toBeUndefined();
    expect(await Effect.runPromise(bare.verifyUpload("k", 9_999_999_999, "sig"))).toBe(false);
  });

  it("puts a stream into the backend and refuses one past the byte limit", async () => {
    const mem = memoryBackend();
    const s = makeAssetStore({ backend: mem.backend });
    const put = (text: string, maxBytes: number) =>
      Effect.runPromise(
        Effect.result(
          s.put({
            key: "t1/a1/r.txt",
            body: new Response(text).body!,
            contentType: "text/plain",
            size: text.length,
            maxBytes,
          }),
        ),
      );
    expect((await put("hello", 100))._tag).toBe("Success");
    expect(mem.files.get("t1/a1/r.txt")).toMatchObject({ contentType: "text/plain", size: 5 });
    expect((await put("hello", 3))._tag).toBe("Failure");
  });

  it("defaults to a one hour link on the real clock", async () => {
    const real = makeAssetStore({ backend, links: { publicUrl: "http://x", secret: "s" } });
    const exp = Number(new URL((await Effect.runPromise(real.link("k")))!).searchParams.get("exp"));
    expect(exp - Date.now() / 1000).toBeGreaterThan(3590);
    expect(exp - Date.now() / 1000).toBeLessThanOrEqual(3600);
  });
});

describe("AssetStoreUnavailable", () => {
  it("stores nothing and says why", async () => {
    const run = <A, E>(f: (s: typeof AssetStore.Service) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            return yield* f(yield* AssetStore);
          }).pipe(Effect.provide(AssetStoreUnavailable)),
        ),
      );
    expect(
      await run((s) => s.ingest({ key: "k", url: "u", contentType: null, size: 1, maxBytes: 1 })),
    ).toMatchObject({ failure: { message: "File storage is not configured." } });
    expect(await run((s) => s.get("k"))).toMatchObject({ success: undefined });
    expect(await run((s) => s.link("k"))).toMatchObject({ success: undefined });
    expect(await run((s) => s.verify("k", 1, "s"))).toMatchObject({ success: false });
    expect(await run((s) => s.uploadLink("k"))).toMatchObject({ success: undefined });
    expect(await run((s) => s.verifyUpload("k", 1, "s"))).toMatchObject({ success: false });
    expect(await run((s) => s.remove("k"))).toMatchObject({ success: undefined });
    expect(
      await run((s) =>
        s.put({
          key: "k",
          body: new Response("x").body!,
          contentType: "text/plain",
          size: 1,
          maxBytes: 1,
        }),
      ),
    ).toMatchObject({ failure: { message: "File storage is not configured." } });
  });
});

describe("makeDiskBackend", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const disk = () => {
    const dir = mkdtempSync(join(tmpdir(), "assets-"));
    dirs.push(dir);
    return makeDiskBackend(dir);
  };

  it("writes a file per key and reads it back with a type from its extension", async () => {
    const backend = disk();
    await backend.put("t1/a1/hero.png", new Response("png-bytes").body!, {
      contentType: "image/png",
      size: 9,
    });
    const found = await backend.get("t1/a1/hero.png");
    expect(found).toMatchObject({ contentType: "image/png", size: 9 });
    expect(new TextDecoder().decode(await bytesOf(found!.body))).toBe("png-bytes");
  });

  it("removes a file, and a missing one is fine", async () => {
    const backend = disk();
    await backend.put("t1/a1/x.txt", new Response("x").body!, {
      contentType: "text/plain",
      size: 1,
    });
    await backend.remove("t1/a1/x.txt");
    await backend.remove("t1/a1/x.txt");
    expect(await backend.get("t1/a1/x.txt")).toBeUndefined();
  });

  it("leaves no half-written file when the body fails partway", async () => {
    const backend = disk();
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(
      backend.put("t1/a1/cut.png", failing, { contentType: "image/png", size: 4 }),
    ).rejects.toThrow("connection reset");
    expect(await backend.get("t1/a1/cut.png")).toBeUndefined();
  });

  it("reads a missing key as undefined and refuses a key that leaves the directory", async () => {
    const backend = disk();
    expect(await backend.get("t1/a1/none.png")).toBeUndefined();
    await expect(backend.get("../outside")).rejects.toThrow("escapes the asset directory");
    await expect(
      backend.put("../outside", new Response("x").body!, { contentType: "text/plain", size: 1 }),
    ).rejects.toThrow("escapes the asset directory");
  });
});
