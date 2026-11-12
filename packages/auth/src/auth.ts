import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@project-os/contracts";
import { schema } from "@project-os/db-sqlite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, genericOAuth, type GenericOAuthConfig, oneTimeToken } from "better-auth/plugins";
import {
  type Connections,
  isChannelIdentityEmail,
  type LinkStart,
  makeConnections,
} from "./connections.ts";

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

export const CLICKUP_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: "https://app.clickup.com/api",
  tokenUrl: "https://api.clickup.com/api/v2/oauth/token",
  userInfoUrl: "https://api.clickup.com/api/v2/user",
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
  /**
   * Google Workspace domains (`acme.com`). Set, Google sign-in takes only accounts of these
   * domains, and every such account may use the dashboard; `allowedEmails` outside them are
   * refused. `admin` keeps its password either way.
   */
  readonly allowedDomains?: ReadonlyArray<string>;
  /** Seeded on first use, so a fresh deployment has someone who can sign in. */
  readonly admin?: AdminAccount;
  readonly google?: OAuthClientConfig;
  /**
   * A GitHub App's client (user-to-server tokens). Its installation decides which repos the
   * token can reach, and the person's own access narrows that further.
   */
  readonly github?: OAuthClientConfig;
  /**
   * A ClickUp app's client. ClickUp has no scopes: the token reaches the workspaces the person
   * picked when they authorized, with their own permissions.
   */
  readonly clickup?: OAuthClientConfig;
}

/**
 * ClickUp takes the code exchange as a JSON body and answers with `access_token` (no refresh
 * token or expiry unless it sends them), so it can't use the default form-encoded exchange.
 */
export const clickupGetToken =
  (tokenUrl: string, clientId: string, clientSecret: string): GenericOAuthConfig["getToken"] =>
  async ({ code }) => {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) throw new Error(`ClickUp token exchange failed (${res.status})`);
    const body = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error("ClickUp token exchange returned no access token");
    return {
      tokenType: body.token_type ?? "Bearer",
      accessToken: body.access_token,
      ...(body.refresh_token && { refreshToken: body.refresh_token }),
      ...(body.expires_in && {
        accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1000),
      }),
      raw: body as Record<string, unknown>,
    };
  };

export const clickupUserInfo =
  (userInfoUrl: string): GenericOAuthConfig["getUserInfo"] =>
  async (tokens) => {
    const res = await fetch(userInfoUrl, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    const { user } = (await res.json()) as {
      user?: { id: number | string; username?: string | null; email?: string | null };
    };
    if (!user) return null;
    return {
      id: String(user.id),
      name: user.username ?? String(user.id),
      email: user.email ?? `${user.id}@clickup.invalid`,
      emailVerified: false,
    };
  };

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

const lower = (email: string) => email.trim().toLowerCase();

/** The domain part of an email, lowercased. */
const domainOf = (email: string) => {
  const e = lower(email);
  return e.slice(e.lastIndexOf("@") + 1);
};

/**
 * Google's userinfo, refused unless Google has verified the email and, with `domains`, the
 * account belongs to one of them. Google sets `hd` only on Workspace accounts, so a personal
 * account registered with a company address doesn't pass.
 */
const verifiedGoogleUser =
  (userInfoUrl: string, domains: ReadonlySet<string>): GenericOAuthConfig["getUserInfo"] =>
  async (tokens) => {
    const res = await fetch(userInfoUrl, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) return null;
    // The `profile` scope always brings the name.
    const u = (await res.json()) as {
      sub: string;
      email: string;
      email_verified?: boolean;
      hd?: string;
      name: string;
    };
    if (u.email_verified !== true) return null;
    if (domains.size > 0) {
      const hd = u.hd?.trim().toLowerCase();
      if (!hd || !domains.has(hd) || domainOf(u.email) !== hd) return null;
    }
    return { id: u.sub, email: u.email, emailVerified: true, name: u.name };
  };

/** Dashboard sign-in with Google: identity scopes only, apart from the linking client. */
export const GOOGLE_SIGN_IN = "google-signin";

/** Where Google sign-in lands on the Coordinator, to hand the session to the dashboard. */
export const SIGN_IN_DONE_PATH = "/sign-in/done";

/** The dashboard page that takes a one-time token (`?ott=`) or shows an error (`?error=`). */
const DASHBOARD_LOGIN_PATH = "/login";

/** Google sign-in needs the Coordinator's URL for the callback and the dashboard's to return to. */
const googleSignInConfig = (config: AuthConfig) => {
  const webOrigin = config.webOrigins?.[0];
  return config.google && config.baseURL && webOrigin
    ? { client: { ...GOOGLE_ENDPOINTS, ...config.google }, baseURL: config.baseURL, webOrigin }
    : undefined;
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
  if (config.clickup) {
    const c = { ...CLICKUP_ENDPOINTS, ...config.clickup };
    out.push({
      providerId: "clickup",
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      authorizationUrl: c.authorizationUrl,
      tokenUrl: c.tokenUrl,
      userInfoUrl: c.userInfoUrl,
      scopes: [],
      getToken: clickupGetToken(c.tokenUrl, c.clientId, c.clientSecret),
      getUserInfo: clickupUserInfo(c.userInfoUrl),
      disableSignUp: true,
    });
  }
  return out;
};

const signInProviders = (config: AuthConfig): GenericOAuthConfig[] => {
  const google = googleSignInConfig(config);
  if (!google) return [];
  const { client } = google;
  const domains = allowedDomains(config);
  // One domain: Google's account chooser shows only that domain's accounts. It's a hint; the
  // check is in `verifiedGoogleUser`.
  const [onlyDomain] = domains.size === 1 ? domains : [];
  return [
    {
      providerId: GOOGLE_SIGN_IN,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      authorizationUrl: client.authorizationUrl,
      tokenUrl: client.tokenUrl,
      userInfoUrl: client.userInfoUrl,
      scopes: ["openid", "email", "profile"],
      ...(onlyDomain && { authorizationUrlParams: { hd: onlyDomain } }),
      getUserInfo: verifiedGoogleUser(client.userInfoUrl, domains),
    },
  ];
};

const betterAuthFor = (config: AuthConfig, isOperator: (email: string) => boolean) =>
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
    // Better Auth skips its origin check when NODE_ENV=test or TEST is set; never skip it.
    advanced: { disableOriginCheck: false },
    // Operators are seeded (`admin`), never signed up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // A connect link already says whose account it is, so the provider's email needn't match.
        allowDifferentEmails: true,
        // Linking needs a trusted provider or a verified email, and GitHub and ClickUp never
        // report theirs verified. Sign-in joins an existing user only on a verified email, since
        // `google-signin` isn't trusted; the account hook keeps the linking clients off operators.
        trustedProviders: ["github", "clickup"],
      },
    },
    // A dashboard session lasts a week and renews itself while in use.
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    databaseHooks: {
      user: {
        create: {
          // Users are operators on the allowlist, or people's channel identities for linking.
          before: async (user) =>
            isOperator(user.email) || isChannelIdentityEmail(user.email) ? undefined : false,
        },
      },
      account: {
        create: {
          // `/connect` links only to a channel identity. Refusing these on an operator keeps a
          // GitHub account claiming the operator's (unverified) email from taking it over.
          before: async (account, ctx) => {
            if (!(CONNECTION_PROVIDERS as ReadonlyArray<string>).includes(account.providerId)) {
              return undefined;
            }
            const user = await ctx!.context.internalAdapter.findUserById(account.userId);
            return isChannelIdentityEmail(user!.email) ? undefined : false;
          },
        },
      },
    },
    plugins: [
      genericOAuth({ config: [...linkingProviders(config), ...signInProviders(config)] }),
      bearer(),
      // Hands a Google sign-in's session from the Coordinator's origin to the dashboard's.
      oneTimeToken({ disableClientRequest: true, storeToken: "hashed" }),
    ],
  });

export type BetterAuth = ReturnType<typeof betterAuthFor>;

/** Dashboard sign-in with Google, when Google, PUBLIC_URL and WEB_ORIGIN are all set. */
export interface GoogleSignIn {
  /** `allowedDomains`: the only Google Workspace domains that may sign in; empty for any. */
  readonly domains: ReadonlyArray<string>;
  /** The redirect to Google, with the state cookies the browser must carry back. */
  readonly start: () => Promise<LinkStart>;
  /** Where the browser goes once Google is done: the dashboard, holding a one-time token. */
  readonly handoff: (request: Request) => Promise<string>;
}

/** The user behind a session token. */
export interface SessionUser {
  readonly userId: string;
  readonly email: string;
}

/** `allowedDomains`, lowercased and without a leading `@`. */
const allowedDomains = (config: AuthConfig): ReadonlySet<string> =>
  new Set(
    (config.allowedDomains ?? [])
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );

/**
 * Who may use the dashboard: `admin`, then anyone at `allowedDomains` when set, otherwise the
 * `allowedEmails`.
 */
const operatorCheck = (config: AuthConfig) => {
  const admin = config.admin && lower(config.admin.email);
  const domains = allowedDomains(config);
  const emails = new Set((config.allowedEmails ?? []).map(lower));
  return (email: string) => {
    const e = lower(email);
    if (e === admin) return true;
    return domains.size > 0 ? domains.has(domainOf(e)) : emails.has(e);
  };
};

/**
 * The Coordinator's one Better Auth instance: dashboard sign-in (`/api/auth/*`, session
 * tokens sent as `Authorization: Bearer`), and account linking when an OAuth client is set.
 */
export const makeAuth = (config: AuthConfig) => {
  const isOperator = operatorCheck(config);
  const auth = betterAuthFor(config, isOperator);

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
      ? makeConnections(auth, { baseURL: config.baseURL, providers })
      : undefined;

  const google = googleSignInConfig(config);
  const googleSignIn: GoogleSignIn | undefined = google && {
    domains: [...allowedDomains(config)],
    start: async () => {
      const { headers, response } = await auth.api.signInSocial({
        body: {
          provider: GOOGLE_SIGN_IN,
          callbackURL: `${google.baseURL}${SIGN_IN_DONE_PATH}`,
          // Better Auth adds `?error=<code>`: not allowed, email unverified, and so on.
          errorCallbackURL: `${google.webOrigin}${DASHBOARD_LOGIN_PATH}`,
          disableRedirect: true,
        },
        returnHeaders: true,
      });
      return { redirect: response.url!, setCookies: headers.getSetCookie() };
    },
    handoff: async (request) => {
      const login = new URL(DASHBOARD_LOGIN_PATH, google.webOrigin);
      // The session cookie Better Auth just set on this origin is the one thing read here.
      const ott = await auth.api
        .generateOneTimeToken({ headers: request.headers })
        .catch(() => undefined);
      if (ott) login.searchParams.set("ott", ott.token);
      else login.searchParams.set("error", "no_session");
      return login.toString();
    },
  };

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
    isAllowed: isOperator,
    /** Account linking; undefined without `baseURL` or an OAuth client. */
    connections,
    /** Google sign-in for the dashboard; undefined without Google, `baseURL` and a web origin. */
    googleSignIn,
  };
};

export type Auth = ReturnType<typeof makeAuth>;
