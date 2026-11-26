import { describe, expect, it } from "vite-plus/test";
import { coordinatorConfig, parseAdminUserIds } from "./config.ts";

const base = {
  run: (() => Promise.resolve()) as never,
  publicUrl: "https://coordinator.test",
  admin: {} as never,
};

describe("parseAdminUserIds", () => {
  it("trims, drops empties, and treats unset as nobody", () => {
    expect(parseAdminUserIds(" 1, 2 ,,3,")).toEqual(["1", "2", "3"]);
    expect(parseAdminUserIds(undefined)).toEqual([]);
  });
});

describe("coordinatorConfig", () => {
  it("defaults: no admin channel, mention required, no CORS", () => {
    const config = coordinatorConfig({ ...base, env: {} });
    expect(config.http.inbound).toMatchObject({ confidenceThreshold: 0.5, requireMention: true });
    expect(config.http.inbound).not.toHaveProperty("adminChannelId");
    expect(config.http.commands).not.toHaveProperty("adminChannelId");
    expect(config.http.commands?.workers).not.toHaveProperty("installCommand");
    expect(config.corsOrigins).toEqual([]);
    expect(config).not.toHaveProperty("credentialProxy");
  });

  it("mounts the credential proxy only when SANDBOX_CREDENTIAL_PROXY opts in", () => {
    const on = coordinatorConfig({ ...base, env: { SANDBOX_CREDENTIAL_PROXY: "true" } });
    expect(on.credentialProxy).toEqual({});
    const off = coordinatorConfig({ ...base, env: { SANDBOX_CREDENTIAL_PROXY: "false" } });
    expect(off).not.toHaveProperty("credentialProxy");
  });

  it("gives inbound and commands the same admin channel and parsed user ids", () => {
    const config = coordinatorConfig({
      ...base,
      env: { ADMIN_CHANNEL_ID: "chan", ADMIN_USER_IDS: "a, b" },
    });
    expect(config.http.inbound).toMatchObject({ adminChannelId: "chan", adminUserIds: ["a", "b"] });
    expect(config.http.commands).toMatchObject({
      adminChannelId: "chan",
      adminUserIds: ["a", "b"],
    });
  });

  it("reads the rest from env", () => {
    const config = coordinatorConfig({
      ...base,
      env: {
        INTENT_CONFIDENCE_THRESHOLD: "0.8",
        DISCORD_REQUIRE_MENTION: "false",
        WATCHER_INSTALL_COMMAND: "curl x | sh",
        WEB_ORIGIN: "https://a.test/, https://b.test",
      },
    });
    expect(config.http.inbound).toMatchObject({ confidenceThreshold: 0.8, requireMention: false });
    expect(config.http.commands?.workers).toMatchObject({
      publicUrl: "https://coordinator.test",
      installCommand: "curl x | sh",
    });
    expect(config.corsOrigins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("lets a caller replace inbound settings", () => {
    const config = coordinatorConfig({
      ...base,
      env: {},
      inbound: { sharedWorkerMaxTickets: 100 },
    });
    expect(config.http.inbound?.sharedWorkerMaxTickets).toBe(100);
  });
});
