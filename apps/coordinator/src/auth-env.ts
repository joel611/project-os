import type { AuthConfig, OAuthClientConfig } from "@project-os/auth";

type Env = Readonly<Record<string, string | undefined>>;

const nonEmpty = (env: Env, key: string) => env[key]?.trim() || undefined;

/** A setting the Coordinator refuses to start without; `why` goes in the error. */
const requiredEnv = (env: Env, key: string, why: string): string => {
  const value = nonEmpty(env, key);
  if (value === undefined) throw new Error(`${key} is required: ${why}`);
  return value;
};

/** COORDINATOR_SERVICE_TOKEN, required: what Channel Adapters call the Coordinator with. */
export const serviceTokenFromEnv = (env: Env): string =>
  requiredEnv(
    env,
    "COORDINATOR_SERVICE_TOKEN",
    "Channel Adapters send it on /inbound, /commands and /prompts/answer",
  );

const oauthClient = (env: Env, prefix: string): OAuthClientConfig | undefined => {
  const clientId = nonEmpty(env, `${prefix}_CLIENT_ID`);
  const clientSecret = nonEmpty(env, `${prefix}_CLIENT_SECRET`);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

/** `ADMIN_EMAILS`: comma-separated. */
const emails = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);

/**
 * Better Auth settings from env. BETTER_AUTH_SECRET is required. ADMIN_EMAIL with
 * ADMIN_PASSWORD seeds an operator who can sign in to the dashboard.
 */
export const authConfigFromEnv = (
  env: Env,
  base: Pick<AuthConfig, "db" | "baseURL" | "webOrigins">,
): AuthConfig => {
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
    allowedEmails: emails(env.ADMIN_EMAILS),
    ...(adminEmail && adminPassword && { admin: { email: adminEmail, password: adminPassword } }),
    ...(google && { google }),
    ...(github && { github }),
    ...(clickup && { clickup }),
  };
};
