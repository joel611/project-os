// What the Cloudflare deploy (alchemy.run.ts) binds to the Coordinator Worker. Pure data:
// deploy-env.test.ts checks it against every setting the Coordinator reads.

/** Plain vars with the same defaults as `.env.example`; set to "" counts as unset. */
export const vars = {
  DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
  DECISION_MODEL: "openrouter/typesafe/jev-1.14",
  INTENT_CONFIDENCE_THRESHOLD: "0.5",
  DISCORD_PROJECT_CHANNEL_AUTO_CREATE: "true",
} as const;

/** Plain vars with no default: bound only when set. Keys left out on purpose: `notBound`. */
export const optionalVars = [
  // Where the Coordinator POSTs replies. Set it to run the gateway off-platform; otherwise a
  // DISCORD_BOT_TOKEN deploys it as a Container and the stack sets this itself.
  "DISCORD_SPLIT_GATEWAY_URL",
  "DISCORD_GUILD_ID",
  "DISCORD_PROJECT_CATEGORY_ID",
  "DISCORD_MEMBER_ROLE_IDS",
  "DISCORD_REQUIRE_MENTION",
  "CHANNEL_DIGEST_QUIET_MIN",
  "CHANNEL_DIGEST_MAX_WAIT_MIN",
  "CHANNEL_DIGEST_RETENTION_DAYS",
  "CHANNEL_DIGEST_MODEL",
  "CHANNEL_DIGEST_MAX_MESSAGES",
  "CHANNEL_DIGEST_RETRY_MIN",
  // The Email Digest: off unless set.
  "EMAIL_DIGEST",
  "HEALTH_WORKER_STALE_MIN",
  "HEALTH_UNPICKED_MIN",
  "HEALTH_FOLLOW_UP_MIN",
  "HEALTH_INACTIVITY_FAIL_MIN",
  "AUDIT_RETENTION_DAYS",
  "RUN_LOG_RETENTION_DAYS",
  "ADMIN_CHANNEL_ID",
  "ADMIN_USER_IDS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  // Better Auth: OAuth callbacks and connect links, and more dashboard operators.
  "PUBLIC_URL",
  "ADMIN_EMAILS",
  "GOOGLE_ALLOWED_DOMAINS",
  "GOOGLE_CLIENT_ID",
  "GITHUB_CLIENT_ID",
  "CLICKUP_CLIENT_ID",
  // Registered workers and the cloud sandbox pool.
  "SHARED_WORKER_MAX_TICKETS",
  "WATCHER_INSTALL_COMMAND",
  "WORKER_PROVIDERS",
  "SANDBOX_MCP_URL",
  "SANDBOX_PI_MODEL",
  "SANDBOX_SESSION_TIMEOUT_SECONDS",
  "SANDBOX_CREDENTIAL_PROXY",
  "SANDBOX_EGRESS_URL",
  "DAYTONA_API_URL",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_MAX_CONCURRENT",
  "BOAT_API_URL",
  "BOAT_SANDBOX_SIZE",
  "BOAT_MAX_CONCURRENT",
  "CLOUDFLARE_SANDBOX_URL",
  "CLOUDFLARE_SANDBOX_MAX_CONCURRENT",
] as const;

/** Secrets the Coordinator refuses to start without: the deploy fails when one is unset. */
export const requiredSecrets = ["BETTER_AUTH_SECRET", "COORDINATOR_SERVICE_TOKEN"] as const;

/** Secrets: bound as `secret_text` only when set. */
export const optionalSecrets = [
  "OPENROUTER_API_KEY",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "CLICKUP_CLIENT_SECRET",
  "DAYTONA_API_KEY",
  "BOAT_API_KEY",
  "CLOUDFLARE_SANDBOX_TOKEN",
  "SKILLS_GITHUB_TOKEN",
] as const;

/** Set by the stack itself (the dashboard's URL), not read from the deployer's env. */
export const setByStack = ["WEB_ORIGIN"] as const;

/** Settings the Coordinator reads that the Worker is not given, and why. */
export const notBound: Readonly<Record<string, string>> = {
  PORT: "host only: the port the Bun process listens on",
  DATABASE_PATH: "host only: SQLite file; the Worker has D1",
  DB_PATH: "host only: old name of DATABASE_PATH",
  PI_STORAGE_PATH: "host only: Pi's SQLite file; the Worker keeps sessions in the PiAgent object",
  ASSET_DIR: "host only: attachments on disk; the Worker has R2",
  HEALTH_SWEEP_EVERY_SEC: "host only: timer interval; the Worker runs on a Cron Trigger (ADR 0001)",
  OTEL_SERVICE_NAME: "host only: telemetry is set up by the Bun entry alone",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "host only: telemetry is set up by the Bun entry alone",
  DISCORD_BOT_TOKEN: "bound to the Discord gateway Worker only",
  DAYTONA_MCP_URL: "old name of SANDBOX_MCP_URL; the deploy takes the new name only",
  DAYTONA_PI_MODEL: "old name of SANDBOX_PI_MODEL; the deploy takes the new name only",
  DAYTONA_SESSION_TIMEOUT_SECONDS:
    "old name of SANDBOX_SESSION_TIMEOUT_SECONDS; the deploy takes the new name only",
};
