import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeWorkersKeyValueStore } from "./kv.ts";

/** The slice of a KV namespace the store uses, recording the options each put received. */
const fakeKv = () => {
  const data = new Map<string, string>();
  const puts: Array<{ key: string; options: unknown }> = [];
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string, options?: unknown) => {
      data.set(key, value);
      puts.push({ key, options });
    },
    delete: async (key: string) => void data.delete(key),
  } as unknown as KVNamespace;
  return { kv, puts };
};

describe("Workers KeyValueStore", () => {
  it("sets, gets, and deletes", async () => {
    const { kv } = fakeKv();
    const store = makeWorkersKeyValueStore(kv);
    await Effect.runPromise(store.set("a", "1"));
    expect(await Effect.runPromise(store.get("a"))).toBe("1");
    await Effect.runPromise(store.delete("a"));
    expect(await Effect.runPromise(store.get("a"))).toBeUndefined();
  });

  it("setIfAbsent writes once", async () => {
    const store = makeWorkersKeyValueStore(fakeKv().kv);
    expect(await Effect.runPromise(store.setIfAbsent("k", "first"))).toBe(true);
    expect(await Effect.runPromise(store.setIfAbsent("k", "second"))).toBe(false);
    expect(await Effect.runPromise(store.get("k"))).toBe("first");
  });

  it("raises a TTL under 60 seconds to KV's minimum", async () => {
    const { kv, puts } = fakeKv();
    const store = makeWorkersKeyValueStore(kv);
    await Effect.runPromise(store.set("short", "x", { ttlSeconds: 5 }));
    await Effect.runPromise(store.set("long", "x", { ttlSeconds: 600 }));
    await Effect.runPromise(store.set("none", "x"));
    expect(puts.map((p) => p.options)).toEqual([
      { expirationTtl: 60 },
      { expirationTtl: 600 },
      undefined,
    ]);
  });
});
