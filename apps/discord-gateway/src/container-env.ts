/** What the container's `main.bun.ts` reads; the Worker passes through whichever are set. */
export const CONTAINER_ENV = [
  "DISCORD_BOT_TOKEN",
  "COORDINATOR_URL",
  "COORDINATOR_SERVICE_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_PROJECT_CATEGORY_ID",
  "ADMIN_CHANNEL_ID",
  "DISCORD_MEMBER_ROLE_IDS",
  "ADMIN_USER_IDS",
] as const;

export const REPLY_PORT = 8081;

/** The container's environment: the set keys of the Worker's env, plus the reply port. */
export const containerEnv = (env: Partial<Record<string, unknown>>): Record<string, string> => ({
  ...Object.fromEntries(
    CONTAINER_ENV.flatMap((key) => {
      const value = env[key];
      return typeof value === "string" && value !== "" ? [[key, value]] : [];
    }),
  ),
  DISCORD_SPLIT_GATEWAY_PORT: String(REPLY_PORT),
});
