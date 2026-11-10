import type { BlobBackend } from "@project-os/infra-local/shared";

/**
 * Keeps files in an R2 bucket. R2 needs a stream's length up front, so the body goes through a
 * `FixedLengthStream` of the size Discord reported: bytes beyond it (or short of it) fail the
 * write, and the file is never held in Worker memory.
 */
export const makeR2Backend = (bucket: R2Bucket): BlobBackend => ({
  put: async (key, body, { contentType, size }) => {
    const sized = new FixedLengthStream(size);
    const piped = body.pipeTo(sized.writable);
    // If the body fails, the pipe error is the cause; the put then fails on the cut-off stream.
    await Promise.all([bucket.put(key, sized.readable, { httpMetadata: { contentType } }), piped]);
  },
  get: async (key) => {
    const object = await bucket.get(key);
    if (object === null) return undefined;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size,
    };
  },
});
