import { describe, expect, it } from "vite-plus/test";
import { REDACTED, redactSecrets, RUN_EVENT_TEXT_MAX, sanitizeRunEvent } from "./runs.ts";

describe("redactSecrets", () => {
  it("masks tokens by shape", () => {
    const out = redactSecrets(
      [
        "Authorization: Bearer abcdef1234567890",
        "token=abcdefghij",
        '"api_key": "zzzzzzzzzz"',
        "ghp_abcdefghijklmnopqrstuvwxyz0123",
        "github_pat_abcdefghijklmnopqrstuvwxyz",
        "ya29.a0AfH6SMBabcdefghijklmnop",
        "sk-or-v1-abcdefghijklmnop",
        "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl",
      ].join("\n"),
    );
    expect(out).not.toMatch(
      /abcdef1234567890|abcdefghij|zzzzzzzzzz|ghp_|github_pat_|ya29|sk-or|eyJ/,
    );
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain(`token=${REDACTED}`);
  });

  it("masks known values wherever they appear, and ignores short ones", () => {
    expect(redactSecrets("a my-device-secret b my-device-secret", ["my-device-secret"])).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
    expect(redactSecrets("cat sat", ["cat"])).toBe("cat sat");
  });

  it("leaves ordinary text alone", () => {
    const text = "Reading apps/web/src/index.tsx and running bun test";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("sanitizeRunEvent", () => {
  it("clips long text and marks it", () => {
    const out = sanitizeRunEvent({
      at: "t",
      type: "output",
      text: "x".repeat(RUN_EVENT_TEXT_MAX + 5),
    });
    expect(out.text).toHaveLength(RUN_EVENT_TEXT_MAX);
    expect(out.truncated).toBe(true);
  });
});
