import { type AssetObject, AssetStore, AssetStoreFailed } from "@project-os/core";
import { Effect, Layer } from "effect";

/** Where file bytes live: a directory locally, an R2 bucket on Cloudflare. */
export interface BlobBackend {
  readonly put: (
    key: string,
    body: ReadableStream<Uint8Array>,
    meta: { readonly contentType: string; readonly size: number },
  ) => Promise<void>;
  readonly get: (key: string) => Promise<AssetObject | undefined>;
}

export interface AssetLinksConfig {
  /** Public URL of the Coordinator, where `/assets/...` is served. */
  readonly publicUrl: string;
  /** Signs the links. Anyone holding it can mint a download link. */
  readonly secret: string;
  /** How long a link works. Default 1 hour. */
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

export interface AssetStoreConfig {
  readonly backend: BlobBackend;
  /** Without it no links are issued and every signature is refused. */
  readonly links?: AssetLinksConfig;
  readonly fetch?: (url: string) => Promise<Response>;
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What a signature allows; the purpose is signed, so a download link can't upload. */
type Purpose = "asset" | "upload";

const sign = async (
  secret: string,
  key: string,
  expires: number,
  purpose: Purpose,
): Promise<string> => {
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode(`${purpose}:${key}:${expires}`),
    ),
  );
};

const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const limitBytes = (body: ReadableStream<Uint8Array>, maxBytes: number) => {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) throw new Error(`file is bigger than ${maxBytes} bytes`);
        controller.enqueue(chunk);
      },
    }),
  );
};

/**
 * The `AssetStore` port over any blob backend. Downloads stream straight into the backend, so a
 * large file never sits in memory, and the byte limit is counted on the stream, not trusted from
 * the headers. Links are `<publicUrl>/assets/<key>?exp=&sig=`, HMAC-SHA-256 over key and expiry.
 */
export const makeAssetStore = (config: AssetStoreConfig): typeof AssetStore.Service => {
  const now = config.links?.now ?? Date.now;
  // workerd throws "Illegal invocation" when the global `fetch` is called detached.
  // The host allowlist is checked on the first URL only, so a redirect elsewhere is refused.
  const download = config.fetch ?? ((url: string) => fetch(url, { redirect: "manual" }));
  const signedUrl = (key: string, purpose: Purpose) =>
    Effect.promise(async () => {
      const links = config.links;
      if (!links) return undefined;
      const expires = Math.floor(now() / 1000) + (links.ttlSeconds ?? 3600);
      const sig = await sign(links.secret, key, expires, purpose);
      const path = key.split("/").map(encodeURIComponent).join("/");
      return `${links.publicUrl.replace(/\/+$/, "")}/assets/${path}?exp=${expires}&sig=${sig}`;
    });
  const verifySig = (key: string, expires: number, sig: string, purpose: Purpose) =>
    Effect.promise(async () => {
      const links = config.links;
      if (!links || expires * 1000 < now()) return false;
      return sameText(sig, await sign(links.secret, key, expires, purpose));
    });
  return {
    ingest: ({ key, url, contentType, size, maxBytes }) =>
      Effect.tryPromise({
        try: async () => {
          const res = await download(url);
          if (!res.ok || res.body === null) throw new Error(`download refused (${res.status})`);
          await config.backend.put(key, limitBytes(res.body, maxBytes), {
            contentType:
              contentType ?? res.headers.get("content-type") ?? "application/octet-stream",
            size,
          });
        },
        catch: (err) => new AssetStoreFailed({ message: messageOf(err) }),
      }),
    get: (key) =>
      Effect.tryPromise({
        try: () => config.backend.get(key),
        catch: (err) => new AssetStoreFailed({ message: messageOf(err) }),
      }),
    link: (key) => signedUrl(key, "asset"),
    verify: (key, expires, sig) => verifySig(key, expires, sig, "asset"),
    uploadLink: (key) => signedUrl(key, "upload"),
    verifyUpload: (key, expires, sig) => verifySig(key, expires, sig, "upload"),
    put: ({ key, body, contentType, size, maxBytes }) =>
      Effect.tryPromise({
        try: () => config.backend.put(key, limitBytes(body, maxBytes), { contentType, size }),
        catch: (err) => new AssetStoreFailed({ message: messageOf(err) }),
      }),
  };
};

/** Placeholder until an entry file supplies storage: nothing is stored, no links are issued. */
export const AssetStoreUnavailable = Layer.succeed(AssetStore, {
  ingest: () => Effect.fail(new AssetStoreFailed({ message: "File storage is not configured." })),
  get: () => Effect.undefined,
  link: () => Effect.undefined,
  verify: () => Effect.succeed(false),
  uploadLink: () => Effect.undefined,
  verifyUpload: () => Effect.succeed(false),
  put: () => Effect.fail(new AssetStoreFailed({ message: "File storage is not configured." })),
});
