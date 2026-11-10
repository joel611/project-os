import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clickupGetToken, clickupUserInfo } from "./auth.ts";

describe("ClickUp OAuth", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubFetch = (res: Response) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => res.clone());
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  const exchange = () =>
    clickupGetToken("http://cu/token", "id", "secret")!({ code: "c1", redirectURI: "http://cb" });

  it("exchanges the code with a JSON body and keeps a bare token without expiry", async () => {
    const fetch = stubFetch(Response.json({ access_token: "at" }));
    const tokens = await exchange();
    expect(tokens).toMatchObject({ accessToken: "at", tokenType: "Bearer" });
    expect(tokens).not.toHaveProperty("accessTokenExpiresAt");
    const init = fetch.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "id",
      client_secret: "secret",
      code: "c1",
    });
  });

  it("keeps a refresh token and expiry when ClickUp sends them", async () => {
    stubFetch(
      Response.json({
        access_token: "at",
        token_type: "bearer",
        refresh_token: "rt",
        expires_in: 3600,
      }),
    );
    const tokens = await exchange();
    expect(tokens).toMatchObject({ tokenType: "bearer", refreshToken: "rt" });
    expect(tokens.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails the exchange on a refusal or a response without a token", async () => {
    stubFetch(new Response("no", { status: 400 }));
    await expect(exchange()).rejects.toThrow("token exchange failed (400)");
    stubFetch(Response.json({}));
    await expect(exchange()).rejects.toThrow("no access token");
  });

  const userInfo = () => clickupUserInfo("http://cu/user")!({ accessToken: "at" } as never);

  it("reads the account from /user with the Bearer token", async () => {
    const fetch = stubFetch(
      Response.json({ user: { id: 7, username: "ada", email: "ada@example.com" } }),
    );
    expect(await userInfo()).toEqual({
      id: "7",
      name: "ada",
      email: "ada@example.com",
      emailVerified: false,
    });
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: "Bearer at" });
  });

  it("falls back to the id when ClickUp hides the name and email", async () => {
    stubFetch(Response.json({ user: { id: 7 } }));
    expect(await userInfo()).toMatchObject({ name: "7", email: "7@clickup.invalid" });
  });

  it("returns null when ClickUp refuses or sends no user", async () => {
    stubFetch(new Response("no", { status: 401 }));
    expect(await userInfo()).toBeNull();
    stubFetch(Response.json({}));
    expect(await userInfo()).toBeNull();
  });
});
