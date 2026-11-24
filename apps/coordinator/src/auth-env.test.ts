import { describe, expect, it } from "vite-plus/test";
import { adminMcpFromEnv, authConfigFromEnv, serviceTokenFromEnv } from "./auth-env.ts";

const base = { baseURL: "http://localhost:8080" };

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
    expect(config.allowedDomains).toEqual([]);
  });

  it("reads the Google sign-in domains, comma-separated", () => {
    const config = authConfigFromEnv(
      { BETTER_AUTH_SECRET: "s", GOOGLE_ALLOWED_DOMAINS: " acme.com, acme.io ,," },
      base,
    );
    expect(config.allowedDomains).toEqual(["acme.com", "acme.io"]);
  });

  it("links accounts with whichever OAuth clients are fully set", () => {
    const config = authConfigFromEnv(
      {
        BETTER_AUTH_SECRET: "s",
        GOOGLE_CLIENT_ID: "g",
        GOOGLE_CLIENT_SECRET: "gs",
        GITHUB_CLIENT_ID: "h",
      },
      base,
    );
    expect(config.google).toEqual({ clientId: "g", clientSecret: "gs" });
    expect(config.github).toBeUndefined();
    expect(config.admin).toBeUndefined();
    expect(config.allowedEmails).toEqual([]);
    const both = authConfigFromEnv(
      { BETTER_AUTH_SECRET: "s", GITHUB_CLIENT_ID: "h", GITHUB_CLIENT_SECRET: "hs" },
      base,
    );
    expect(both.github).toEqual({ clientId: "h", clientSecret: "hs" });
    expect(both.clickup).toBeUndefined();
    const clickup = authConfigFromEnv(
      { BETTER_AUTH_SECRET: "s", CLICKUP_CLIENT_ID: "c", CLICKUP_CLIENT_SECRET: "cs" },
      base,
    );
    expect(clickup.clickup).toEqual({ clientId: "c", clientSecret: "cs" });
  });

  it("refuses to start without COORDINATOR_SERVICE_TOKEN", () => {
    expect(() => serviceTokenFromEnv({})).toThrow(/COORDINATOR_SERVICE_TOKEN is required/);
    expect(serviceTokenFromEnv({ COORDINATOR_SERVICE_TOKEN: " tok " })).toBe("tok");
  });

  it("refuses an admin email without a password", () => {
    expect(() =>
      authConfigFromEnv({ BETTER_AUTH_SECRET: "s", ADMIN_EMAIL: "ops@example.com" }, base),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});

describe("adminMcpFromEnv", () => {
  const deps = { workerStaleMs: 1000 };
  const token = "t".repeat(32);

  it("is off without ADMIN_MCP_TOKEN, set or blank", () => {
    expect(adminMcpFromEnv({}, deps)).toBeUndefined();
    expect(adminMcpFromEnv({ ADMIN_MCP_TOKEN: "  " }, deps)).toBeUndefined();
  });

  it("refuses a token that is too short", () => {
    expect(() => adminMcpFromEnv({ ADMIN_MCP_TOKEN: "short" }, deps)).toThrow(
      /ADMIN_MCP_TOKEN must be at least 32 characters/,
    );
  });

  it("masks the token and the other configured secrets in tool output", () => {
    const config = adminMcpFromEnv(
      {
        ADMIN_MCP_TOKEN: token,
        COORDINATOR_SERVICE_TOKEN: "service-token-value",
        BETTER_AUTH_SECRET: "auth-secret-value",
      },
      deps,
    );
    expect(config).toMatchObject({ token, workerStaleMs: 1000 });
    expect(config?.secrets).toEqual([token, "service-token-value", "auth-secret-value"]);
  });
});
