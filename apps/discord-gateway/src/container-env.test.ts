import { describe, expect, it } from "vite-plus/test";
import { containerEnv } from "./container-env.ts";

describe("containerEnv", () => {
  it("passes the set Discord keys and the reply port, and nothing else", () => {
    const env = containerEnv({
      DISCORD_BOT_TOKEN: "tok",
      COORDINATOR_URL: "https://coordinator.example",
      COORDINATOR_SERVICE_TOKEN: "svc",
      DISCORD_GUILD_ID: "g1",
      Gateway: { not: "a string" },
      OPENROUTER_API_KEY: "must-not-leak",
    });

    expect(env).toEqual({
      DISCORD_BOT_TOKEN: "tok",
      COORDINATOR_URL: "https://coordinator.example",
      COORDINATOR_SERVICE_TOKEN: "svc",
      DISCORD_GUILD_ID: "g1",
      DISCORD_SPLIT_GATEWAY_PORT: "8081",
    });
  });

  it("drops empty and non-string values, so a Bun default applies in the container", () => {
    expect(containerEnv({ ADMIN_CHANNEL_ID: "", ADMIN_USER_IDS: undefined })).toEqual({
      DISCORD_SPLIT_GATEWAY_PORT: "8081",
    });
  });
});
