import { EMAIL_BODY_MAX, redactEmailBody } from "@project-os/core";
import { describe, expect, it } from "vite-plus/test";

describe("redactEmailBody", () => {
  it("masks tokens, keys and secrets", () => {
    const out = redactEmailBody(
      [
        "key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
        "Authorization: Bearer abcdef1234567890xyz",
        "password: hunter2 and your PIN is 4821",
        "github_pat_abcdefghijklmnopqrstu1234 xoxb-1234567890-abcdefghij AIzaSyA1234567890abcdefghijklmnopqrstuv ya29.a0Abcdefghijklmnopqrstu",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    );
    for (const secret of [
      "sk-abcdefghijklmnop1234",
      "ghp_abcdef",
      "AKIAABCDEFGH",
      "eyJhbGciOi",
      "abcdef1234567890xyz",
      "hunter2",
      "4821",
      "MIIabc",
      "github_pat_abc",
      "xoxb-1234",
      "AIzaSyA1234",
      "ya29.a0A",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("password: [redacted secret]");
  });

  it("masks one-time codes, cards, SSNs, IBANs and long phone/account numbers", () => {
    const out = redactEmailBody(
      "Your verification code: 482913. Card 4242 4242 4242 4242, SSN 123-45-6789, IBAN GB82 WEST 1234 5698 7654 32, call +1 (415) 555-0132.",
    );
    expect(out).not.toMatch(/482913|4242|123-45|GB82|555-0132/);
    expect(out).toContain("[redacted card]");
  });

  it("keeps ordinary numbers: dates, amounts and short references", () => {
    const text = "Invoice due 2026-11-24 for 1,250.00 USD, ref 20481, 3 items.";
    expect(redactEmailBody(text)).toBe(text);
  });

  it("still masks a long digit run that is not a valid card", () => {
    expect(redactEmailBody("ref 1234 5678 9012 3456")).toBe("ref [redacted number]");
  });

  it("strips link query strings and the address part of emails, keeping the domain", () => {
    const out = redactEmailBody(
      "Open https://app.test/reset/abc?token=SECRET123&u=1#frag or write ada@acme.test.",
    );
    expect(out).toContain("https://app.test/reset/abc");
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("[email]@acme.test");
    expect(out).not.toContain("ada@");
  });

  it("drops quoted replies and tidies blank lines", () => {
    const out = redactEmailBody(
      "Sounds good.\r\n\r\n\r\n\r\nOn Tue, 24 Nov 2026 at 10:00, Dana <d@x.test> wrote:\r\n> old text\r\n> more",
    );
    expect(out).toBe("Sounds good.");
  });

  it("cuts a long body", () => {
    const out = redactEmailBody("word ".repeat(5000));
    expect(out.length).toBe(EMAIL_BODY_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});
