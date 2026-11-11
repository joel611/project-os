import type { ConnectionProvider } from "@project-os/contracts";
import {
  ConnectionsUnavailable,
  type LinkedAccount,
  NotConnected,
  type Person,
  UserConnections,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import type { BetterAuth } from "./auth.ts";

export interface ConnectionsConfig {
  /** Public URL of the Coordinator: the browser opens connect links and OAuth callbacks here. */
  readonly baseURL: string;
  /** Providers with an OAuth client on the Better Auth instance. */
  readonly providers: ReadonlyArray<ConnectionProvider>;
  /** How long a connect link works. Default 10 minutes. */
  readonly linkTtlSeconds?: number;
}

/** Where the OAuth flow lands the browser when it's done. Served by the Coordinator. */
export const CONNECT_DONE_PATH = "/connect/done";

const who = (person: Person) => person.name ?? person.id;

const CHANNEL_IDENTITY_DOMAIN = "@people.project-os.invalid";

/** One auth user per channel identity; Better Auth wants an email, so it gets a stable fake. */
export const emailFor = (person: Person) =>
  `${person.channelType}-${person.id}${CHANNEL_IDENTITY_DOMAIN}`.toLowerCase();

/** Whether an auth user stands for a person on a channel rather than a dashboard operator. */
export const isChannelIdentityEmail = (email: string) =>
  email.toLowerCase().endsWith(CHANNEL_IDENTITY_DOMAIN);

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

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
export const makeConnections = (auth: BetterAuth, config: ConnectionsConfig) => {
  const configured = new Set<string>(config.providers);
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
        if (!configured.has(provider)) return yield* unavailable(provider);
        const notConnected = (message: string) =>
          new NotConnected({ provider, personId: person.id, message });
        const found = yield* Effect.promise(() => findAccount(person, provider));
        if (!found) {
          return yield* notConnected(`${who(person)} has not linked a ${provider} account.`);
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
    try {
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
      return { redirect: response.url, setCookies: headers.getSetCookie() };
    } finally {
      // The provider flow no longer needs the session: the link target travels in the state.
      // Also on failure, so a link that never reached the provider leaves no live session.
      // The token stays used either way; the person runs /connect again.
      await ctx.internalAdapter.deleteSession(session.token);
    }
  };

  return {
    service,
    layer: Layer.succeed(UserConnections, service),
    startLink,
  };
};

export type Connections = ReturnType<typeof makeConnections>;
