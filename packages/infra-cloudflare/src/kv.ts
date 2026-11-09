import type { KeyValueStore } from "@project-os/core";
import { Effect } from "effect";

type Store = typeof KeyValueStore.Service;

/** Workers KV rejects `expirationTtl` below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;

const putOptions = (ttlSeconds: number | undefined) =>
  ttlSeconds === undefined
    ? undefined
    : { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlSeconds)) };

/**
 * KeyValueStore over a Workers KV namespace.
 *
 * Two differences from the in-memory store:
 * - A TTL under 60 seconds is raised to 60 (a KV limit).
 * - `setIfAbsent` is read-then-write, not atomic, and KV is eventually consistent across
 *   locations. Two simultaneous deliveries of the same inbound message can both win. Moving
 *   dedupe to a D1 unique key or a Durable Object would close that gap.
 */
export const makeWorkersKeyValueStore = (kv: KVNamespace): Store => ({
  get: (key) => Effect.promise(async () => (await kv.get(key)) ?? undefined),
  set: (key, value, options) =>
    Effect.promise(() => kv.put(key, value, putOptions(options?.ttlSeconds))),
  setIfAbsent: (key, value, options) =>
    Effect.promise(async () => {
      if ((await kv.get(key)) !== null) return false;
      await kv.put(key, value, putOptions(options?.ttlSeconds));
      return true;
    }),
  delete: (key) => Effect.promise(() => kv.delete(key)),
});
