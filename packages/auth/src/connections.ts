import type { ConnectionProvider } from "@project-os/contracts";
import {
  ConnectionsUnavailable,
  type LinkedAccount,
  NotConnected,
  type Person,
  type SharedAccountRef,
  type UserAccessToken,
  UserConnections,
} from "@project-os/core";
import { Effect, Layer } from "effect";
import type { BetterAuth } from "./auth.ts";

export interface ConnectionsConfig {
  /** Public URL of the Coordinator: the browser opens connect links and OAuth callbacks here. */
  readonly baseURL: string;
  /** Providers with an OAuth client on the Better Auth instance. */
  readonly providers: ReadonlyArray<ConnectionProvider>;
  readonly userInfoUrls: Record<ConnectionProvider, string>;
  /** How long a connect link works. Default 10 minutes. */
  readonly linkTtlSeconds?: number;
  /** The shared account an admin assigned `person` for `provider`, if any. */
  readonly sharedFor?: (
    person: Person,
    provider: ConnectionProvider,
  ) => Promise<
    { readonly id: string; readonly label: string; readonly userId: string } | undefined
  >;
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

const CHANNEL_TYPES: ReadonlyArray<string> = ["discord", "email", "chat"];

/**
 * The person a channel identity's auth user stands for (the inverse of `emailFor`). The id comes
 * back lowercased, as `emailFor` stored it: Discord ids are digits, so nothing is lost there.
 */
export const personFromIdentityEmail = (email: string, name?: string): Person | undefined => {
  const e = email.toLowerCase();
  if (!e.endsWith(CHANNEL_IDENTITY_DOMAIN)) return undefined;
  const local = e.slice(0, -CHANNEL_IDENTITY_DOMAIN.length);
  const dash = local.indexOf("-");
  const channelType = local.slice(0, dash);
  const id = local.slice(dash + 1);
  if (dash < 1 || !id || !CHANNEL_TYPES.includes(channelType)) return undefined;
  return {
    channelType: channelType as Person["channelType"],
    id,
    ...(name && name !== id ? { name } : {}),
  };
};

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
 * link-social flow, which stores the provider tokens (encrypted) on an `account` row.
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

  /** Each linked account of an auth user, with the provider's own name for it when readable. */
  const linkedAccounts = async (userId: string): Promise<ReadonlyArray<LinkedAccount>> => {
    const ctx = await context();
    const accounts = (await ctx.internalAdapter.findAccounts(userId)).filter((a) =>
      configured.has(a.providerId),
    );
    return Promise.all(
      accounts.map(async (account): Promise<LinkedAccount> => {
        const provider = account.providerId as ConnectionProvider;
        const linked: LinkedAccount = { provider, accountId: account.accountId };
        const url = config.userInfoUrls[provider];
        try {
          const tokens = await auth.api.getAccessToken({
            body: { accountId: account.id, userId },
          });
          const response = await fetch(url, {
            headers: {
              authorization: `Bearer ${tokens.accessToken}`,
              accept: "application/json",
              ...(provider === "github" && { "user-agent": "project-os" }),
            },
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) return linked;
          const body = (await response.json()) as Record<string, unknown>;
          const profile = provider === "clickup" ? body.user : body;
          if (!profile || typeof profile !== "object") return linked;
          const info = profile as Record<string, unknown>;
          const id = provider === "google" ? info.sub : info.id;
          if (String(id) !== account.accountId) return linked;
          const identity =
            provider === "google" ? info.email : provider === "github" ? info.login : info.username;
          const valid =
            typeof identity === "string" &&
            identity.length <= 254 &&
            (provider === "google"
              ? /^[A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+$/.test(identity)
              : provider === "github"
                ? /^[A-Za-z0-9-]{1,39}$/.test(identity)
                : /^[\p{L}\p{N}_.@ -]{1,100}$/u.test(identity));
          return valid ? { ...linked, displayIdentity: identity } : linked;
        } catch {
          return linked;
        }
      }),
    );
  };

  /** A fresh access token for one of an auth user's linked accounts, or null once it's dead. */
  const tokenOf = async (userId: string, provider: ConnectionProvider) => {
    const ctx = await context();
    const account = (await ctx.internalAdapter.findAccounts(userId)).find(
      (a) => a.providerId === provider,
    );
    if (!account) return null;
    // Refreshes first when the stored token is (nearly) expired.
    return auth.api
      .getAccessToken({ body: { accountId: account.id, userId } })
      .then((tokens): UserAccessToken => ({
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt
          ? new Date(tokens.accessTokenExpiresAt).toISOString()
          : null,
        scopes: tokens.scopes,
      }))
      .catch(() => null);
  };

  /** A one-time link that runs `provider`'s OAuth flow for an auth user, when opened. */
  const connectLink = async (userId: string, provider: ConnectionProvider) => {
    const token = randomToken();
    const ctx = await context();
    await ctx.internalAdapter.createVerificationValue({
      identifier: `connect:${token}`,
      value: JSON.stringify({ userId, provider }),
      expiresAt: new Date(Date.now() + linkTtlMs),
    });
    return `${config.baseURL}/connect/${token}`;
  };

  const unavailable = (provider: ConnectionProvider) =>
    new ConnectionsUnavailable({
      message: `${provider} accounts can't be linked here: no OAuth client is configured.`,
    });

  const service: UserConnections["Service"] = {
    connectUrl: (person, provider) =>
      configured.has(provider)
        ? Effect.promise(async () => connectLink((await ensureUser(person)).id, provider))
        : Effect.fail(unavailable(provider)),

    list: (person) =>
      Effect.promise(async (): Promise<ReadonlyArray<LinkedAccount>> => {
        const user = await findUser(person);
        return user ? linkedAccounts(user.id) : [];
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
        const notConnected = (message: string, sharedAccount?: SharedAccountRef) =>
          new NotConnected({
            provider,
            personId: person.id,
            message,
            ...(sharedAccount && { sharedAccount }),
          });
        const found = yield* Effect.promise(() => findAccount(person, provider));
        if (!found) {
          // Never linked their own: the shared account an admin assigned them, if any.
          const shared = yield* Effect.promise(async () => config.sharedFor?.(person, provider));
          if (!shared) {
            return yield* notConnected(`${who(person)} has not linked a ${provider} account.`);
          }
          const ref = (identity?: string): SharedAccountRef => ({
            id: shared.id,
            label: shared.label,
            ...(identity && { identity }),
          });
          const sharedToken = yield* Effect.promise(() => tokenOf(shared.userId, provider));
          if (!sharedToken) {
            return yield* notConnected(
              `The shared ${provider} account "${shared.label}" has expired or was revoked; an admin needs to connect it again.`,
              ref(),
            );
          }
          const identity = yield* Effect.promise(
            async () =>
              (await linkedAccounts(shared.userId)).find((a) => a.provider === provider)
                ?.displayIdentity,
          );
          return { ...sharedToken, sharedAccount: ref(identity) };
        }
        const token = yield* Effect.promise(() => tokenOf(found.user.id, provider));
        if (!token) {
          return yield* notConnected(
            `The ${provider} link for ${who(person)} has expired or was revoked; it needs connecting again.`,
          );
        }
        return token;
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
    /** For shared accounts, which are auth users of their own rather than channel people. */
    forUser: { linkedAccounts, connectLink },
  };
};

export type Connections = ReturnType<typeof makeConnections>;
