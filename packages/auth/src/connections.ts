import type { ConnectionProvider } from "@project-os/contracts";
import {
  ConnectionsUnavailable,
  type LinkedAccount,
  NotConnected,
  type Person,
  UserConnections,
} from "@project-os/core";
import { schema } from "@project-os/db-sqlite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, genericOAuth, type GenericOAuthConfig } from "better-auth/plugins";
import { Effect, Layer } from "effect";

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

export interface ConnectionsConfig {
  /** Drizzle database holding the `auth_*` tables (see `@project-os/db-sqlite`). */
  readonly db: Parameters<typeof drizzleAdapter>[0];
  /** Public URL of the Coordinator: the browser opens connect links and OAuth callbacks here. */
  readonly baseURL: string;
  /** Signs cookies and encrypts stored OAuth tokens. At least 32 random characters. */
  readonly secret: string;
  readonly google?: OAuthClientConfig;
  /**
   * A GitHub App's client (user-to-server tokens). Its installation decides which repos the
   * token can reach, and the person's own access narrows that further.
   */
  readonly github?: OAuthClientConfig;
  /** How long a connect link works. Default 10 minutes. */
  readonly linkTtlSeconds?: number;
}

/** Where the OAuth flow lands the browser when it's done. Served by the Coordinator. */
export const CONNECT_DONE_PATH = "/connect/done";

const who = (person: Person) => person.name ?? person.id;

/** One auth user per channel identity; Better Auth wants an email, so it gets a stable fake. */
const emailFor = (person: Person) =>
  `${person.channelType}-${person.id}@people.project-os.invalid`.toLowerCase();

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
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

const providerConfigs = (config: ConnectionsConfig): GenericOAuthConfig[] => {
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

export const makeAuth = (config: ConnectionsConfig) =>
  betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: [config.baseURL],
    database: drizzleAdapter(config.db, {
      provider: "sqlite",
      schema: {
        user: schema.authUsers,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
      },
    }),
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
    // Sessions exist only to carry one link request; keep them short.
    session: { expiresIn: 15 * 60, disableSessionRefresh: true },
    plugins: [genericOAuth({ config: providerConfigs(config) }), bearer()],
  });

export type Auth = ReturnType<typeof makeAuth>;

/** What `GET /connect/:token` answers: go to the provider, carrying these cookies. */
export interface LinkStart {
  readonly redirect: string;
  readonly setCookies: ReadonlyArray<string>;
}

/**
 * Account linking on Better Auth. Each person gets an auth user; `/connect` hands out a
 * one-time link that signs the browser in as that user just long enough to run Better Auth's
 * link-social flow, which stores the provider tokens (encrypted) on an `auth_accounts` row.
 */
export const makeConnections = (config: ConnectionsConfig) => {
  const auth = makeAuth(config);
  const configured = new Set<string>(providerConfigs(config).map((p) => p.providerId));
  const linkTtlMs = (config.linkTtlSeconds ?? 600) * 1000;
  const context = () => auth.$context;

  const findUser = async (person: Person) => {
    const ctx = await context();
    return (await ctx.internalAdapter.findUserByEmail(emailFor(person)))?.user ?? null;
  };

  const ensureUser = async (person: Person) => {
    const existing = await findUser(person);
    if (existing) return existing;
    const ctx = await context();
    return ctx.internalAdapter.createUser(
      {
        email: emailFor(person),
        name: who(person),
        emailVerified: false,
      },
      { method: "channel-identity" },
    );
  };

  const findAccount = async (person: Person, provider: ConnectionProvider) => {
    const user = await findUser(person);
    if (!user) return null;
    const ctx = await context();
    const account = (await ctx.internalAdapter.findAccounts(user.id)).find(
      (a) => a.providerId === provider,
    );
    return account ? { user, account } : null;
  };

  const unavailable = (provider: ConnectionProvider) =>
    new ConnectionsUnavailable({
      message: `${provider} accounts can't be linked here: no OAuth client is configured.`,
    });

  const service: UserConnections["Service"] = {
    connectUrl: (person, provider) =>
      configured.has(provider)
        ? Effect.promise(async () => {
            const user = await ensureUser(person);
            const token = randomToken();
            const ctx = await context();
            await ctx.internalAdapter.createVerificationValue({
              identifier: `connect:${token}`,
              value: JSON.stringify({ userId: user.id, provider }),
              expiresAt: new Date(Date.now() + linkTtlMs),
            });
            return `${config.baseURL}/connect/${token}`;
          })
        : Effect.fail(unavailable(provider)),

    list: (person) =>
      Effect.promise(async (): Promise<ReadonlyArray<LinkedAccount>> => {
        const user = await findUser(person);
        if (!user) return [];
        const ctx = await context();
        return (await ctx.internalAdapter.findAccounts(user.id))
          .filter((a) => configured.has(a.providerId))
          .map((a) => ({ provider: a.providerId as ConnectionProvider, accountId: a.accountId }));
      }),

    disconnect: (person, provider) =>
      Effect.promise(async () => {
        const found = await findAccount(person, provider);
        if (!found) return false;
        const ctx = await context();
        await ctx.internalAdapter.deleteAccount(found.account.id);
        return true;
      }),

    accessToken: (person, provider) =>
      Effect.gen(function* () {
        if (!configured.has(provider)) return yield* Effect.fail(unavailable(provider));
        const notConnected = (message: string) =>
          new NotConnected({ provider, personId: person.id, message });
        const found = yield* Effect.promise(() => findAccount(person, provider));
        if (!found) {
          return yield* Effect.fail(
            notConnected(`${who(person)} has not linked a ${provider} account.`),
          );
        }
        // Refreshes first when the stored token is (nearly) expired.
        const tokens = yield* Effect.tryPromise({
          try: () =>
            auth.api.getAccessToken({
              body: { accountId: found.account.id, userId: found.user.id },
            }),
          catch: () =>
            notConnected(
              `The ${provider} link for ${who(person)} has expired or was revoked; it needs connecting again.`,
            ),
        });
        return {
          accessToken: tokens.accessToken,
          expiresAt: tokens.accessTokenExpiresAt
            ? new Date(tokens.accessTokenExpiresAt).toISOString()
            : null,
          scopes: tokens.scopes,
        };
      }),
  };

  /** Redeems a connect link: signs the browser in as its person and starts the provider flow. */
  const startLink = async (token: string): Promise<LinkStart | null> => {
    const ctx = await context();
    const verification = await ctx.internalAdapter.consumeVerificationValue(`connect:${token}`);
    if (!verification || new Date(verification.expiresAt).getTime() < Date.now()) return null;
    const { userId, provider } = JSON.parse(verification.value) as {
      userId: string;
      provider: ConnectionProvider;
    };
    const session = await ctx.internalAdapter.createSession(userId);
    const done = `${config.baseURL}${CONNECT_DONE_PATH}?provider=${provider}`;
    const { headers, response } = await auth.api.linkSocialAccount({
      body: {
        provider,
        callbackURL: done,
        errorCallbackURL: done,
        disableRedirect: true,
      },
      headers: new Headers({ authorization: `Bearer ${session.token}` }),
      returnHeaders: true,
    });
    // The provider flow no longer needs the session: the link target travels in the state.
    await ctx.internalAdapter.deleteSession(session.token);
    return { redirect: response.url, setCookies: headers.getSetCookie() };
  };

  return {
    auth,
    service,
    layer: Layer.succeed(UserConnections, service),
    startLink,
    /** Better Auth's own routes (`/api/auth/*`), including the OAuth callbacks. */
    handler: (request: Request) => auth.handler(request),
  };
};

export type Connections = ReturnType<typeof makeConnections>;
