import { describe, expect, it } from "vite-plus/test";
import { createTail, redact } from "./tail.ts";

describe("redact", () => {
  it("hides GitHub, Google and bearer tokens and given secrets", () => {
    const text = [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "pat github_pat_abcdefghijklmnopqrstuv_wxyz",
      "google ya29.a0AbCdEfGhIjKlMnOpQrStUv",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "device s3cret-value",
    ].join("\n");
    const out = redact(text, ["s3cret-value"]);
    expect(out).not.toMatch(/ghp_|github_pat_|ya29|abcdefghijklmnop|s3cret/);
    expect(out).toContain("Bearer [redacted]");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("Blocked: 404 for joel611/project-os")).toBe(
      "Blocked: 404 for joel611/project-os",
    );
  });
});

describe("createTail", () => {
  it("keeps only the last maxChars", () => {
    const tail = createTail([], 10);
    tail.push("0123456789");
    tail.push("abcde");
    expect(tail.read()).toBe("56789abcde");
  });

  it("redacts a token split across chunks", () => {
    const tail = createTail();
    tail.push("using ghp_abcdefghij");
    tail.push("klmnopqrstuvwxyz0123 now");
    expect(tail.read()).toBe("using [redacted] now");
  });
});
