import type { AuthSettings, OAuthClientConfig } from "@project-os/auth";
import type { Member } from "@project-os/contracts";

type Env = Readonly<Record<string, string | undefined>>;

const nonEmpty = (env: Env, key: string) => env[key]?.trim() || undefined;

const requiredEnv = (env: Env, key: string, why: string): string => {
  const value = nonEmpty(env, key);
  if (value === undefined) throw new Error(`${key} is required: ${why}`);
  return value;
};

export const serviceTokenFromEnv = (env: Env): string =>
  requiredEnv(
    env,
    "COORDINATOR_SERVICE_TOKEN",
    "Channel Adapters send it on /inbound, /commands and /prompts/answer",
  );

/** Shortest `ADMIN_MCP_TOKEN` accepted: it is a static credential, so it must not be guessable. */
export const ADMIN_MCP_TOKEN_MIN_LENGTH = 32;

/**
 * `ADMIN_MCP_TOKEN` turns on the read-only admin MCP at `/mcp/admin` (generate one with
 * `openssl rand -base64 32`). Unset: the endpoint is not mounted. A short one fails the start.
 * The configured secrets are masked wherever they appear in tool output.
 */
export const adminMcpFromEnv = (
  env: Env,
  deps: {
    readonly workerStaleMs: number;
    readonly members?: () => Promise<ReadonlyArray<Member>>;
  },
) => {
  const token = nonEmpty(env, "ADMIN_MCP_TOKEN");
  if (token === undefined) return undefined;
  if (token.length < ADMIN_MCP_TOKEN_MIN_LENGTH) {
    throw new Error(
      `ADMIN_MCP_TOKEN must be at least ${ADMIN_MCP_TOKEN_MIN_LENGTH} characters (generate one with \`openssl rand -base64 32\`)`,
    );
  }
  const secrets = [
    token,
    ...["COORDINATOR_SERVICE_TOKEN", "BETTER_AUTH_SECRET", "ADMIN_PASSWORD"]
      .map((key) => nonEmpty(env, key))
      .filter((value): value is string => value !== undefined),
  ];
  return { token, secrets, ...deps };
};

const oauthClient = (env: Env, prefix: string): OAuthClientConfig | undefined => {
  const clientId = nonEmpty(env, `${prefix}_CLIENT_ID`);
  const clientSecret = nonEmpty(env, `${prefix}_CLIENT_SECRET`);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Better Auth settings from env. BETTER_AUTH_SECRET is required. ADMIN_EMAIL with
 * ADMIN_PASSWORD seeds an operator who can sign in to the dashboard. GOOGLE_ALLOWED_DOMAINS
 * limits Google sign-in to those Workspace domains and lets anyone at them in.
 */
export const authConfigFromEnv = (
  env: Env,
  base: Pick<AuthSettings, "baseURL" | "webOrigins">,
): AuthSettings => {
  const google = oauthClient(env, "GOOGLE");
  const github = oauthClient(env, "GITHUB");
  const clickup = oauthClient(env, "CLICKUP");
  const adminEmail = nonEmpty(env, "ADMIN_EMAIL");
  const adminPassword = nonEmpty(env, "ADMIN_PASSWORD");
  if (adminEmail && !adminPassword) throw new Error("ADMIN_EMAIL is set without ADMIN_PASSWORD");
  return {
    ...base,
    secret: requiredEnv(
      env,
      "BETTER_AUTH_SECRET",
      "it signs dashboard sessions (generate one with `openssl rand -base64 32`)",
    ),
    allowedEmails: list(env.ADMIN_EMAILS),
    allowedDomains: list(env.GOOGLE_ALLOWED_DOMAINS),
    ...(adminEmail && adminPassword && { admin: { email: adminEmail, password: adminPassword } }),
    ...(google && { google }),
    ...(github && { github }),
    ...(clickup && { clickup }),
  };
};
