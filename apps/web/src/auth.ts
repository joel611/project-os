import { ApiError } from "./api.ts";

/**
 * Where Better Auth lives: `/api/auth` on the Coordinator. Without `VITE_COORDINATOR_URL`, the
 * Vite dev server forwards `/api/auth` there unchanged.
 */
export const authBase = (coordinatorUrl: string | undefined): string =>
  coordinatorUrl ? `${coordinatorUrl.replace(/\/+$/, "")}/api/auth` : "/api/auth";

/** Sign-in and sign-out against the Coordinator's Better Auth. */
export const makeAuthClient = (
  fetchFn: typeof fetch = fetch,
  base: string = authBase(import.meta.env.VITE_COORDINATOR_URL as string | undefined),
) => ({
  /** The new session token, or null when the email and password don't match. */
  signIn: async (email: string, password: string): Promise<string | null> => {
    const res = await fetchFn(`${base}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    const token = res.headers.get("set-auth-token");
    if (!token) throw new ApiError(res.status, "NoSessionToken");
    return token;
  },
  /** Ends the session on the Coordinator. Best effort: the caller forgets the token anyway. */
  signOut: async (token: string): Promise<void> => {
    await fetchFn(`${base}/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  },
});

export const authClient = makeAuthClient();
