import { describe, expect, it } from "vite-plus/test";
import { heldOpen } from "./held-open.ts";

const input = { env: {}, command: "true", timeoutSeconds: 1 };

describe("heldOpen", () => {
  it("hands the session to waitUntil and still returns it", async () => {
    const held: Promise<unknown>[] = [];
    const result = { exitCode: 0, output: "ok" };
    const runner = heldOpen({ run: async () => result }, (p) => held.push(p));
    await expect(runner.run(input)).resolves.toBe(result);
    expect(held).toHaveLength(1);
  });

  it("keeps a failed session from rejecting the held promise", async () => {
    const held: Promise<unknown>[] = [];
    const runner = heldOpen({ run: () => Promise.reject(new Error("boom")) }, (p) => held.push(p));
    await expect(runner.run(input)).rejects.toThrow("boom");
    await expect(held[0]).resolves.toBeUndefined();
  });
});
