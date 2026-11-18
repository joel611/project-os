// A fake OAuth 2.0 provider on localhost, standing in for Google, GitHub and ClickUp in the
// integration stack. It approves every authorize request at once and hands out numbered
// tokens, so tests can see which token a Worker got and when a refresh happened.

export interface FakeOAuth {
  readonly url: string;
  /** Endpoints for one provider id (`google`, `github` or `clickup`). */
  readonly endpoints: (provider: string) => {
    authorizationUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
  };
  /** Every token request, in order (`grant_type` + provider). */
  readonly tokenRequests: Array<{ provider: string; grantType: string }>;
  /** Seconds until each new access token expires; 0 leaves `expires_in` out (never expires). */
  expiresIn: number;
  /** Refuse refresh grants, as a provider does for a revoked or expired refresh token. */
  failRefresh: boolean;
  /** Fail the userinfo call, so linking can't learn who the account is. */
  failUserInfo: boolean;
  malformedUserInfo: "missing" | "invalid-json" | undefined;
  /** The Google account's id (`sub`), the same for every client of one Google project. */
  sub: string;
  /** The Google account's email. */
  email: string;
  /** What Google says about whether it verified the account's email. */
  emailVerified: boolean;
  /** The Google Workspace domain (`hd`); undefined for a personal account. */
  hd: string | undefined;
  /** The query of every authorize request, in order. */
  readonly authorizeRequests: URLSearchParams[];
  /** The GitHub account's numeric id and login; a second account needs a different id. */
  githubId: number;
  githubLogin: string;
  /** The GitHub account's public email; null when it keeps it private. */
  githubEmail: string | null;
  readonly stop: () => void;
}

export const startFakeOAuth = (): FakeOAuth => {
  let n = 0;
  const tokenRequests: FakeOAuth["tokenRequests"] = [];
  const authorizeRequests: URLSearchParams[] = [];
  // A GitHub token keeps speaking for the account that was set when it was issued.
  const githubOwners = new Map<string, { id: number; login: string }>();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, provider, action] = url.pathname.split("/");
      if (action === "authorize") {
        authorizeRequests.push(url.searchParams);
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", `code-${provider}`);
        back.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(back.toString(), 302);
      }
      if (action === "token" && req.method === "POST") {
        // ClickUp exchanges the code with a JSON body and has no grant_type; the rest post a form.
        const grantType =
          provider === "clickup"
            ? "authorization_code"
            : new URLSearchParams(await req.text()).get("grant_type")!;
        if (provider === "clickup") await req.json(); // a form body would throw: it must be JSON
        tokenRequests.push({ provider: provider!, grantType });
        if (grantType === "refresh_token" && fake.failRefresh) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        n += 1;
        if (provider === "github") {
          githubOwners.set(`at-github-${n}`, { id: fake.githubId, login: fake.githubLogin });
        }
        // ClickUp tokens come bare: no refresh token, expiry or scope.
        if (provider === "clickup") {
          return Response.json({ access_token: `at-clickup-${n}`, token_type: "Bearer" });
        }
        return Response.json({
          access_token: `at-${provider}-${n}`,
          refresh_token: `rt-${provider}-${n}`,
          token_type: "Bearer",
          ...(fake.expiresIn > 0 && { expires_in: fake.expiresIn }),
          scope: "openid email profile drive.readonly",
        });
      }
      // userinfo
      if (fake.failUserInfo) return new Response("unauthorized", { status: 401 });
      if (fake.malformedUserInfo === "invalid-json") return new Response("not json");
      if (fake.malformedUserInfo === "missing") return Response.json({});
      if (provider === "clickup") {
        return Response.json({ user: { id: 7, username: "ada-cu", email: "ada@example.com" } });
      }
      return provider === "github"
        ? Response.json({
            ...githubOwners.get(req.headers.get("authorization")!.slice("Bearer ".length))!,
            name: null,
            email: fake.githubEmail,
          })
        : Response.json({
            sub: fake.sub,
            email: fake.email,
            email_verified: fake.emailVerified,
            ...(fake.hd && { hd: fake.hd }),
            name: "Ada Lovelace",
          });
    },
  });
  const url = `http://localhost:${server.port}`;
  const fake: FakeOAuth = {
    url,
    endpoints: (provider) => ({
      authorizationUrl: `${url}/${provider}/authorize`,
      tokenUrl: `${url}/${provider}/token`,
      userInfoUrl: `${url}/${provider}/userinfo`,
    }),
    tokenRequests,
    expiresIn: 3600,
    failRefresh: false,
    failUserInfo: false,
    malformedUserInfo: undefined,
    sub: "google-ada",
    email: "ada@example.com",
    emailVerified: true,
    hd: undefined,
    authorizeRequests,
    githubId: 42,
    githubLogin: "ada-gh",
    githubEmail: null,
    stop: () => server.stop(true),
  };
  return fake;
};
