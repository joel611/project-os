// A fake OAuth 2.0 provider on localhost, standing in for Google and GitHub in the
// integration stack. It approves every authorize request at once and hands out numbered
// tokens, so tests can see which token a Worker got and when a refresh happened.

export interface FakeOAuth {
  readonly url: string;
  /** Endpoints for one provider id (`google` or `github`). */
  readonly endpoints: (provider: string) => {
    authorizationUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
  };
  /** Every token request, in order (`grant_type` + provider). */
  readonly tokenRequests: Array<{ provider: string; grantType: string }>;
  /** Seconds until each new access token expires. */
  expiresIn: number;
  readonly stop: () => void;
}

export const startFakeOAuth = (): FakeOAuth => {
  let n = 0;
  const tokenRequests: FakeOAuth["tokenRequests"] = [];
  const state = { expiresIn: 3600 };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, provider, action] = url.pathname.split("/");
      if (action === "authorize") {
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", `code-${provider}`);
        back.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(back.toString(), 302);
      }
      if (action === "token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        tokenRequests.push({ provider: provider!, grantType: form.get("grant_type")! });
        n += 1;
        return Response.json({
          access_token: `at-${provider}-${n}`,
          refresh_token: `rt-${provider}-${n}`,
          token_type: "Bearer",
          expires_in: state.expiresIn,
          scope: "openid email profile drive.readonly",
        });
      }
      if (action === "userinfo") {
        return provider === "github"
          ? Response.json({ id: 42, login: "ada-gh", name: null, email: null })
          : Response.json({
              sub: "google-ada",
              email: "ada@example.com",
              email_verified: true,
              name: "Ada Lovelace",
            });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://localhost:${server.port}`;
  return {
    url,
    endpoints: (provider) => ({
      authorizationUrl: `${url}/${provider}/authorize`,
      tokenUrl: `${url}/${provider}/token`,
      userInfoUrl: `${url}/${provider}/userinfo`,
    }),
    tokenRequests,
    get expiresIn() {
      return state.expiresIn;
    },
    set expiresIn(value) {
      state.expiresIn = value;
    },
    stop: () => server.stop(true),
  };
};
