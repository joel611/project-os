import { Database } from "bun:sqlite";
import { classifierReturning } from "@project-os/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { browse } from "./browse.ts";
import { OPERATOR, type Stack, startStack } from "./stack.ts";

// Dashboard sign-in with Google: the dashboard sends the browser to /sign-in/google on the
// Coordinator -> fake Google authorize -> Better Auth callback (real) -> /sign-in/done, which
// hands the session back to the dashboard as a one-time token -> the dashboard trades it at
// /api/auth/one-time-token/verify for its Bearer token. The fake Google account is ada@example.com.

const ADA = "ada@example.com";

let stack: Stack;
afterEach(() => stack.stop());

const start = (options: { allowedEmails?: ReadonlyArray<string> } = {}) =>
  startStack({ classifier: classifierReturning("new_request"), connections: true, ...options });

/** Plays the browser from the dashboard's button to where it lands back on the dashboard. */
const signInWithGoogle = async () => {
  const page = await browse(`${stack.url}/sign-in/google`);
  return new URL(page.url);
};

/** What the dashboard's login page does with `?ott=`. */
const exchange = (ott: string) =>
  fetch(`${stack.url}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ott }),
  });

const projects = (token: string) =>
  fetch(`${stack.url}/projects`, { headers: { authorization: `Bearer ${token}` } });

const query = <T>(sql: string, ...params: string[]): T[] => {
  const db = new Database(stack.dbPath, { readonly: true });
  const rows = db.query(sql).all(...params) as T[];
  db.close();
  return rows;
};

const usersWithEmail = (email: string) =>
  query<{ n: number }>("select count(*) as n from auth_users where email = ?", email)[0]!.n;

/** How each sign-in method and linked account hangs off the user(s) with this email. */
const accountsOf = (email: string) =>
  query<{ userId: string; providerId: string }>(
    `select u.id as userId, a.provider_id as providerId from auth_users u
     join auth_accounts a on a.user_id = u.id where u.email = ? order by a.provider_id`,
    email,
  );

const sessionsOf = (email: string) =>
  query<{ n: number }>(
    `select count(*) as n from auth_sessions s join auth_users u on u.id = s.user_id
     where u.email = ?`,
    email,
  )[0]!.n;

const signInWithPassword = () =>
  fetch(`${stack.url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OPERATOR),
  });

const sessionUserId = async (token: string) => {
  const res = await fetch(`${stack.url}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as { user: { id: string } }).user.id;
};

describe("Google sign-in", () => {
  it("lets an allowed Google account into the dashboard API", async () => {
    stack = await start({ allowedEmails: [ADA] });
    expect(await (await fetch(`${stack.url}/sign-in/providers`)).json()).toEqual({ google: true });

    const landed = await signInWithGoogle();
    expect(landed.origin).toBe(stack.webUrl);
    expect(landed.pathname).toBe("/login");
    const ott = landed.searchParams.get("ott");
    expect(ott, landed.toString()).toBeTruthy();

    const verified = await exchange(ott!);
    expect(verified.status).toBe(200);
    const token = verified.headers.get("set-auth-token")!;
    expect(token).toBeTruthy();
    const res = await projects(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    // The one-time token works once.
    expect((await exchange(ott!)).ok).toBe(false);
  });

  it("refuses a Google account that isn't on the allowlist, and creates no user", async () => {
    stack = await start();
    const landed = await signInWithGoogle();
    expect(landed.origin).toBe(stack.webUrl);
    expect(landed.pathname).toBe("/login");
    expect(landed.searchParams.get("ott")).toBeNull();
    expect(landed.searchParams.get("error")).toBeTruthy();
    expect(usersWithEmail(ADA)).toBe(0);
  });

  it("refuses an allowed account whose email Google hasn't verified", async () => {
    stack = await start({ allowedEmails: [ADA] });
    stack.oauth!.emailVerified = false;
    const landed = await signInWithGoogle();
    expect(landed.searchParams.get("ott")).toBeNull();
    expect(landed.searchParams.get("error")).toBeTruthy();
    expect(usersWithEmail(ADA)).toBe(0);
  });

  it("refuses when Google won't say who the account is", async () => {
    stack = await start({ allowedEmails: [ADA] });
    stack.oauth!.failUserInfo = true;
    const landed = await signInWithGoogle();
    expect(landed.searchParams.get("ott")).toBeNull();
    expect(landed.searchParams.get("error")).toBeTruthy();
  });

  it("hands over nothing without a session from Google", async () => {
    stack = await start({ allowedEmails: [ADA] });
    const landed = new URL((await browse(`${stack.url}/sign-in/done`)).url);
    expect(landed.searchParams.get("error")).toBe("no_session");
  });

  it("signs the password operator in with Google of the same verified email, as the same user", async () => {
    stack = await start();
    stack.oauth!.email = OPERATOR.email;
    const [operator] = accountsOf(OPERATOR.email);

    const landed = await signInWithGoogle();
    const verified = await exchange(landed.searchParams.get("ott")!);
    const token = verified.headers.get("set-auth-token")!;
    expect((await projects(token)).status).toBe(200);
    expect(await sessionUserId(token)).toBe(operator!.userId);
    expect(usersWithEmail(OPERATOR.email)).toBe(1);
    expect(accountsOf(OPERATOR.email)).toEqual([
      { userId: operator!.userId, providerId: "credential" },
      { userId: operator!.userId, providerId: "google-signin" },
    ]);

    const password = await signInWithPassword();
    expect(await sessionUserId(password.headers.get("set-auth-token")!)).toBe(operator!.userId);
  });

  it("won't join the operator on an email Google hasn't verified", async () => {
    stack = await start();
    stack.oauth!.email = OPERATOR.email;
    stack.oauth!.emailVerified = false;
    const landed = await signInWithGoogle();
    expect(landed.searchParams.get("ott")).toBeNull();
    expect(landed.searchParams.get("error")).toBeTruthy();
    expect(accountsOf(OPERATOR.email).map((a) => a.providerId)).toEqual(["credential"]);
  });

  it("never lets a GitHub account claiming the operator's email sign in as the operator", async () => {
    stack = await start();
    stack.oauth!.githubEmail = OPERATOR.email;
    const sessions = sessionsOf(OPERATOR.email);

    const started = await fetch(`${stack.url}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: stack.url },
      body: JSON.stringify({
        provider: "github",
        callbackURL: `${stack.webUrl}/`,
        errorCallbackURL: `${stack.webUrl}/login`,
        disableRedirect: true,
      }),
    });
    const { url } = (await started.json()) as { url: string };
    const page = await browse(url, { url: stack.url, setCookies: started.headers.getSetCookie() });

    expect(new URL(page.url).searchParams.get("error")).toBeTruthy();
    expect(accountsOf(OPERATOR.email).map((a) => a.providerId)).toEqual(["credential"]);
    expect(sessionsOf(OPERATOR.email)).toBe(sessions);
  });
});

describe("without Google", () => {
  it("offers only the password, and has no Google route", async () => {
    stack = await startStack({ classifier: classifierReturning("new_request") });
    expect(await (await fetch(`${stack.url}/sign-in/providers`)).json()).toEqual({
      google: false,
    });
    expect((await fetch(`${stack.url}/sign-in/google`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${stack.url}/sign-in/done`, { redirect: "manual" })).status).toBe(404);
  });
});
