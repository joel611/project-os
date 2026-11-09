import { Elysia } from "elysia";

/** What the Coordinator needs from `@project-os/auth` to serve sign-in. */
export interface AuthDeps {
  /** Better Auth's own routes under `/api/auth`: sign-in, sign-out, OAuth callbacks. */
  readonly handler: (request: Request) => Promise<Response>;
}

export const authRoutes = ({ handler }: AuthDeps) =>
  new Elysia({ name: "auth-routes" }).all("/api/auth/*", ({ request }) => handler(request));
