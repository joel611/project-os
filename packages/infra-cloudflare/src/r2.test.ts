import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeR2Backend } from "./r2.ts";

// workerd supplies FixedLengthStream and the R2 binding; here both are stand-ins. The real ones
// run in apps/e2e/src/r2-assets.test.ts.

class FixedLengthStreamStandIn extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw new Error(`expected ${length} bytes, got ${seen}`);
      },
    });
  }
}

const fakeBucket = () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string | undefined }>();
  const bucket = {
    put: async (
      key: string,
      body: ReadableStream<Uint8Array>,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      objects.set(key, {
        bytes: new Uint8Array(await new Response(body).arrayBuffer()),
        contentType: options?.httpMetadata?.contentType,
      });
    },
    delete: async (key: string) => void objects.delete(key),
    get: async (key: string) => {
      const object = objects.get(key);
      return object
        ? {
            body: new Response(object.bytes).body!,
            size: object.bytes.byteLength,
            httpMetadata: object.contentType ? { contentType: object.contentType } : undefined,
          }
        : null;
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
};

const body = (bytes: Uint8Array) => new Response(bytes).body!;

describe("R2 blob backend", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes through a fixed-length stream with the content type, and reads it back", async () => {
    vi.stubGlobal("FixedLengthStream", FixedLengthStreamStandIn);
    const { bucket, objects } = fakeBucket();
    const backend = makeR2Backend(bucket);

    await backend.put("t1/a1/hero.png", body(new Uint8Array([1, 2, 3])), {
      contentType: "image/png",
      size: 3,
    });

    expect(objects.get("t1/a1/hero.png")).toMatchObject({ contentType: "image/png" });
    const found = await backend.get("t1/a1/hero.png");
    expect(found).toMatchObject({ contentType: "image/png", size: 3 });
    expect(new Uint8Array(await new Response(found!.body).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("fails the write when the body is not the reported size", async () => {
    vi.stubGlobal("FixedLengthStream", FixedLengthStreamStandIn);
    const backend = makeR2Backend(fakeBucket().bucket);
    await expect(
      backend.put("k", body(new Uint8Array([1, 2, 3])), { contentType: "image/png", size: 5 }),
    ).rejects.toThrow();
  });

  it("deletes an object", async () => {
    const { bucket, objects } = fakeBucket();
    objects.set("k", { bytes: new Uint8Array([1]) });
    await makeR2Backend(bucket).remove("k");
    expect(objects.has("k")).toBe(false);
  });

  it("reads a missing key as undefined and an untyped object as binary", async () => {
    const { bucket, objects } = fakeBucket();
    const backend = makeR2Backend(bucket);
    expect(await backend.get("nope")).toBeUndefined();
    objects.set("raw", { bytes: new Uint8Array([9]) });
    expect(await backend.get("raw")).toMatchObject({ contentType: "application/octet-stream" });
  });
});
