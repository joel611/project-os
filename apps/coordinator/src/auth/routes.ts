import { type GoogleSignIn, SIGN_IN_DONE_PATH } from "@project-os/auth";
import { Elysia } from "elysia";

/** What the Coordinator needs from `@project-os/auth` to serve sign-in. */
export interface AuthDeps {
  /** Better Auth's own routes under `/api/auth`: sign-in, sign-out, OAuth callbacks. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Dashboard sign-in with Google. Omitted: the dashboard offers email and password only. */
  readonly googleSignIn?: GoogleSignIn | undefined;
}

const redirect = (location: string, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/**
 * Better Auth at `/api/auth/*`, plus Google sign-in for the dashboard. Google returns to this
 * origin, where the dashboard can't read the session, so `/sign-in/done` hands it over as a
 * one-time token in the redirect back to the dashboard.
 */
export const authRoutes = ({ handler, googleSignIn }: AuthDeps) =>
  new Elysia({ name: "auth-routes" })
    .all("/api/auth/*", ({ request }) => handler(request))
    .get("/sign-in/providers", () => ({ google: googleSignIn !== undefined }))
    .get("/sign-in/google", async ({ set }) => {
      if (!googleSignIn) {
        set.status = 404;
        return { error: "GoogleSignInNotConfigured" };
      }
      const start = await googleSignIn.start();
      return redirect(start.redirect, start.setCookies);
    })
    .get(SIGN_IN_DONE_PATH, async ({ request, set }) => {
      if (!googleSignIn) {
        set.status = 404;
        return { error: "GoogleSignInNotConfigured" };
      }
      return redirect(await googleSignIn.handoff(request));
    });
