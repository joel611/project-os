import type { KeyValueStore } from "@project-os/core";
import { Effect } from "effect";

type Store = typeof KeyValueStore.Service;

/** In-memory KV with TTL. Entries expire lazily on read. */
export const makeMemoryKeyValueStore = (nowMs: () => number): Store => {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  const live = (key: string) => {
    const hit = entries.get(key);
    if (hit && hit.expiresAt <= nowMs()) {
      entries.delete(key);
      return undefined;
    }
    return hit;
  };

  const write = (key: string, value: string, ttlSeconds?: number) => {
    entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? Infinity : nowMs() + ttlSeconds * 1000,
    });
  };

  return {
    get: (key) => Effect.sync(() => live(key)?.value),
    set: (key, value, options) => Effect.sync(() => write(key, value, options?.ttlSeconds)),
    setIfAbsent: (key, value, options) =>
      Effect.sync(() => {
        const absent = live(key) === undefined;
        if (absent) write(key, value, options?.ttlSeconds);
        return absent;
      }),
    delete: (key) => Effect.sync(() => void entries.delete(key)),
  };
};
