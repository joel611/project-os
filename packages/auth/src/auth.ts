import type { ConnectionProvider } from "@project-os/contracts";
import { schema } from "@project-os/db-sqlite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, genericOAuth, type GenericOAuthConfig } from "better-auth/plugins";
import { type Connections, makeConnections } from "./connections.ts";

/** OAuth endpoints; tests point these at a fake provider on localhost. */
export interface ProviderEndpoints {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly userInfoUrl: string;
}

export interface OAuthClientConfig extends Partial<ProviderEndpoints> {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Overrides the default scopes. */
  readonly scopes?: ReadonlyArray<string>;
}

export const GOOGLE_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
};

export const GITHUB_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
};

/** Read-only Drive access plus identity, so the account shows who linked it. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
];

/** The operator who can always sign in to the dashboard with a password. */
export interface AdminAccount {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export interface AuthConfig {
  /** Drizzle database holding the `auth_*` tables (see `@project-os/db-sqlite`). */
  readonly db: Parameters<typeof drizzleAdapter>[0];
  /**
   * Public URL of the Coordinator: OAuth callbacks and connect links point here. Unset, Better
   * Auth reads it off each request and account linking stays off.
   */
  readonly baseURL?: string;
  /** Signs session tokens and encrypts stored OAuth tokens. At least 32 random characters. */
  readonly secret: string;
  /** Origins the web dashboard is served from; it signs in from there. */
  readonly webOrigins?: ReadonlyArray<string>;
  /** Emails that may use the dashboard and its API, besides `admin`. */
  readonly allowedEmails?: ReadonlyArray<string>;
  /** Seeded on first use, so a fresh deployment has someone who can sign in. */
  readonly admin?: AdminAccount;
  readonly google?: OAuthClientConfig;
  /**
   * A GitHub App's client (user-to-server tokens). Its installation decides which repos the
   * token can reach, and the person's own access narrows that further.
   */
  readonly github?: OAuthClientConfig;
  /** How long a connect link works. Default 10 minutes. */
  readonly linkTtlSeconds?: number;
}

const githubUserInfo =
  (userInfoUrl: string): GenericOAuthConfig["getUserInfo"] =>
  async (tokens) => {
    const res = await fetch(userInfoUrl, {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "project-os",
      },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as {
      id: number;
      login: string;
      name?: string | null;
      email?: string | null;
    };
    return {
      id: String(u.id),
      name: u.name ?? u.login,
      // A private email comes back null; the noreply address is GitHub's stand-in.
      email: u.email ?? `${u.id}+${u.login}@users.noreply.github.com`,
      emailVerified: false,
    };
  };

/** OAuth clients for account linking (`/connect`): never sign-in, never sign-up. */
const linkingProviders = (config: AuthConfig): GenericOAuthConfig[] => {
  const out: GenericOAuthConfig[] = [];
  if (config.google) {
    const g = { ...GOOGLE_ENDPOINTS, ...config.google };
    out.push({
      providerId: "google",
      clientId: g.clientId,
      clientSecret: g.clientSecret,
      authorizationUrl: g.authorizationUrl,
      tokenUrl: g.tokenUrl,
      userInfoUrl: g.userInfoUrl,
      scopes: [...(g.scopes ?? GOOGLE_SCOPES)],
      // A refresh token, every time, so Workers keep access after the first hour.
      accessType: "offline",
      prompt: "consent",
      pkce: true,
      // Google's userinfo names the account `sub`, not `id`.
      accountSubject: ({ profile }) => String(profile.sub),
      disableSignUp: true,
    });
  }
  if (config.github) {
    const h = { ...GITHUB_ENDPOINTS, ...config.github };
    out.push({
      providerId: "github",
      clientId: h.clientId,
      clientSecret: h.clientSecret,
      authorizationUrl: h.authorizationUrl,
      tokenUrl: h.tokenUrl,
      userInfoUrl: h.userInfoUrl,
      // GitHub Apps ignore scopes; their permissions are set on the app.
      scopes: [...(h.scopes ?? [])],
      getUserInfo: githubUserInfo(h.userInfoUrl),
      disableSignUp: true,
    });
  }
  return out;
};

const betterAuthFor = (config: AuthConfig) =>
  betterAuth({
    ...(config.baseURL && { baseURL: config.baseURL }),
    secret: config.secret,
    trustedOrigins: [...(config.baseURL ? [config.baseURL] : []), ...(config.webOrigins ?? [])],
    database: drizzleAdapter(config.db, {
      provider: "sqlite",
      schema: {
        user: schema.authUsers,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
      },
    }),
    // Operators are seeded (`admin`), never signed up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    account: {
      encryptOAuthTokens: true,
      // Linking only ever starts from a person's own one-time connect link, so the provider's
      // email doesn't need to match (or be verified); sign-in never links implicitly.
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        disableImplicitLinking: true,
        trustedProviders: ["google", "github"],
      },
    },
    // A dashboard session lasts a week and renews itself while in use.
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    plugins: [genericOAuth({ config: linkingProviders(config) }), bearer()],
  });

export type BetterAuth = ReturnType<typeof betterAuthFor>;

/** The user behind a session token. */
export interface SessionUser {
  readonly userId: string;
  readonly email: string;
}

const lower = (email: string) => email.trim().toLowerCase();

/**
 * The Coordinator's one Better Auth instance: dashboard sign-in (`/api/auth/*`, session
 * tokens sent as `Authorization: Bearer`), and account linking when an OAuth client is set.
 */
export const makeAuth = (config: AuthConfig) => {
  const auth = betterAuthFor(config);
  const allowed = new Set(
    [...(config.allowedEmails ?? []), ...(config.admin ? [config.admin.email] : [])].map(lower),
  );

  /** Creates the admin and its password login unless they exist. Safe to run on every boot. */
  const ensureAdmin = async (): Promise<void> => {
    const admin = config.admin;
    if (!admin) return;
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail(lower(admin.email), {
      includeAccounts: true,
    });
    const user =
      found?.user ??
      (await ctx.internalAdapter.createUser(
        { email: lower(admin.email), name: admin.name ?? "Admin", emailVerified: true },
        { method: "admin-seed" },
      ));
    if (found?.accounts.some((a) => a.providerId === "credential")) return;
    await ctx.internalAdapter.linkAccount({
      providerId: "credential",
      accountId: user.id,
      userId: user.id,
      password: await ctx.password.hash(admin.password),
    });
  };
  let seeded: Promise<void> | undefined;
  const seedOnce = () => (seeded ??= ensureAdmin());

  const providers = linkingProviders(config).map((p) => p.providerId as ConnectionProvider);
  const connections: Connections | undefined =
    config.baseURL && providers.length > 0
      ? makeConnections(auth, {
          baseURL: config.baseURL,
          providers,
          ...(config.linkTtlSeconds !== undefined && { linkTtlSeconds: config.linkTtlSeconds }),
        })
      : undefined;

  return {
    auth,
    /** Seeds the admin (see `ensureAdmin`); later calls reuse the first run. */
    ready: seedOnce,
    /** Better Auth's own routes (`/api/auth/*`): sign-in, sign-out, OAuth callbacks. */
    handler: async (request: Request) => {
      await seedOnce();
      return auth.handler(request);
    },
    /** The user a Bearer session token belongs to, or undefined. Cookies are not consulted. */
    sessionUser: async (token: string): Promise<SessionUser | undefined> => {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      return session ? { userId: session.user.id, email: session.user.email } : undefined;
    },
    /** Whether this email may use the dashboard and its API. */
    isAllowed: (email: string) => allowed.has(lower(email)),
    /** Account linking; undefined without `baseURL` or an OAuth client. */
    connections,
  };
};

export type Auth = ReturnType<typeof makeAuth>;
