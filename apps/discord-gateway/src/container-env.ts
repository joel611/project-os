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

/**
 * A stable hash of the container's environment. The container reads its env only when it
 * starts, and the Worker keeps it running, so a deploy that changes a key (a new
 * COORDINATOR_URL or service token) leaves the old values live until the container restarts.
 * Comparing this hash to the one stored at start tells the Worker when to restart it.
 */
export const envFingerprint = async (env: Record<string, string>): Promise<string> => {
  const canonical = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
