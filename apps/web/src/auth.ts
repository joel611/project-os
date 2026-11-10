import { ApiError, apiBase } from "./api.ts";

/**
 * Where Better Auth lives: `/api/auth` on the Coordinator. Without `VITE_COORDINATOR_URL`, the
 * Vite dev server forwards `/api/auth` there unchanged.
 */
export const authBase = (coordinatorUrl: string | undefined): string =>
  coordinatorUrl ? `${coordinatorUrl.replace(/\/+$/, "")}/api/auth` : "/api/auth";

/** Sign-in and sign-out against the Coordinator: Better Auth, plus its Google hand-off. */
export const makeAuthClient = (
  fetchFn: typeof fetch = fetch,
  coordinatorUrl: string | undefined = import.meta.env.VITE_COORDINATOR_URL as string | undefined,
) => {
  const auth = authBase(coordinatorUrl);
  const api = apiBase(coordinatorUrl);
  const tokenFrom = async (res: Response): Promise<string> => {
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    const token = res.headers.get("set-auth-token");
    if (!token) throw new ApiError(res.status, "NoSessionToken");
    return token;
  };
  const post = (path: string, body: unknown) =>
    fetchFn(`${auth}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    /** The new session token, or null when the email and password don't match. */
    signIn: async (email: string, password: string): Promise<string | null> => {
      const res = await post("/sign-in/email", { email, password });
      return res.status === 401 ? null : tokenFrom(res);
    },
    /** Trades the one-time token Google sign-in returned with for a session token. */
    exchange: async (ott: string): Promise<string | null> => {
      const res = await post("/one-time-token/verify", { token: ott });
      return res.status === 400 ? null : tokenFrom(res);
    },
    /** Ends the session on the Coordinator. Best effort: the caller forgets the token anyway. */
    signOut: async (token: string): Promise<void> => {
      await fetchFn(`${auth}/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    },
    /** Which sign-in methods the Coordinator offers besides email and password. */
    providers: async (): Promise<{ readonly google: boolean }> => {
      const res = await fetchFn(`${api}/sign-in/providers`).catch(() => undefined);
      const body: unknown = await res?.json().catch(() => null);
      return { google: (body as { google?: unknown } | null)?.google === true };
    },
    /** Opened as a page, not fetched: Google's state cookies must land on the Coordinator. */
    googleStartUrl: `${api}/sign-in/google`,
  };
};

export const authClient = makeAuthClient();
