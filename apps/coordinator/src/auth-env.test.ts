import { describe, expect, it } from "vite-plus/test";
import { authConfigFromEnv } from "./auth-env.ts";

const base = { db: {} as never, baseURL: "http://localhost:8080" };

describe("authConfigFromEnv", () => {
  it("refuses to start without BETTER_AUTH_SECRET, set or blank", () => {
    expect(() => authConfigFromEnv({}, base)).toThrow(/BETTER_AUTH_SECRET is required/);
    expect(() => authConfigFromEnv({ BETTER_AUTH_SECRET: "  " }, base)).toThrow(
      /BETTER_AUTH_SECRET is required/,
    );
  });

  it("seeds the admin and allows the listed emails", () => {
    const config = authConfigFromEnv(
      {
        BETTER_AUTH_SECRET: "s",
        ADMIN_EMAIL: "ops@example.com",
        ADMIN_PASSWORD: "pw-pw-pw-pw",
        ADMIN_EMAILS: "ada@example.com, bob@example.com,",
      },
      base,
    );
    expect(config.admin).toEqual({ email: "ops@example.com", password: "pw-pw-pw-pw" });
    expect(config.allowedEmails).toEqual(["ada@example.com", "bob@example.com"]);
  });

  it("refuses an admin email without a password", () => {
    expect(() =>
      authConfigFromEnv({ BETTER_AUTH_SECRET: "s", ADMIN_EMAIL: "ops@example.com" }, base),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});
