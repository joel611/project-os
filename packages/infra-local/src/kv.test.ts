import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { makeMemoryKeyValueStore } from "./kv.ts";

describe("memory KeyValueStore", () => {
  const setup = () => {
    let now = 1_000;
    const kv = makeMemoryKeyValueStore(() => now);
    return { kv, advance: (ms: number) => void (now += ms) };
  };

  it("sets, gets, and deletes", async () => {
    const { kv } = setup();
    await Effect.runPromise(kv.set("a", "1"));
    expect(await Effect.runPromise(kv.get("a"))).toBe("1");
    await Effect.runPromise(kv.delete("a"));
    expect(await Effect.runPromise(kv.get("a"))).toBeUndefined();
  });

  it("expires entries after the ttl", async () => {
    const { kv, advance } = setup();
    await Effect.runPromise(kv.set("a", "1", { ttlSeconds: 10 }));
    advance(9_999);
    expect(await Effect.runPromise(kv.get("a"))).toBe("1");
    advance(1);
    expect(await Effect.runPromise(kv.get("a"))).toBeUndefined();
  });

  it("setIfAbsent writes once, and again after expiry", async () => {
    const { kv, advance } = setup();
    expect(await Effect.runPromise(kv.setIfAbsent("k", "1", { ttlSeconds: 5 }))).toBe(true);
    expect(await Effect.runPromise(kv.setIfAbsent("k", "2"))).toBe(false);
    expect(await Effect.runPromise(kv.get("k"))).toBe("1");
    advance(5_000);
    expect(await Effect.runPromise(kv.setIfAbsent("k", "3"))).toBe(true);
    advance(10_000_000);
    expect(await Effect.runPromise(kv.get("k"))).toBe("3");
  });
});
