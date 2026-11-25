import { GOOGLE_SCOPES, type AuthSettings, type OAuthClientConfig } from "@project-os/auth";
import { GMAIL_READ_SCOPE } from "@project-os/contracts";

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
  const googleClient = oauthClient(env, "GOOGLE");
  // With the Email Digest on, linking Google also asks to read mail (and nothing more).
  const google =
    googleClient && /^(true|1|yes|on)$/i.test(env.EMAIL_DIGEST?.trim() ?? "")
      ? { ...googleClient, scopes: [...GOOGLE_SCOPES, GMAIL_READ_SCOPE] }
      : googleClient;
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
