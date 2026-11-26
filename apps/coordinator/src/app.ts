import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { type Access, deny, policyFor } from "./access.ts";
import { type AssetDeps, assetRoutes } from "./assets/routes.ts";
import { type AuthDeps, authRoutes } from "./auth/routes.ts";
import { type ConnectDeps, connectRoutes } from "./connect/routes.ts";
import { type EgressDeps, egressRoutes } from "./egress/routes.ts";
import { httpRoutes, type HttpDeps } from "./http/routes.ts";
import { mcpRoutes, type McpRuntime } from "./mcp/server.ts";
import { runRoutes } from "./runs/routes.ts";
import { skillRoutes } from "./skills/routes.ts";
import { refuseNonWorker } from "./worker-access.ts";

export interface AppDeps {
  /** Who is calling; every route but the public ones and /mcp is refused without someone. */
  readonly access: Access;
  /** HTTP ingress + admin routes (#13). Omitted: no ingress routes. */
  readonly http?: HttpDeps;
  /** MCP server (#12). Omitted: `/mcp` is not mounted. */
  readonly mcp?: McpRuntime;
  /** Sign-in (`/api/auth/*`). Omitted: not mounted. */
  readonly auth?: AuthDeps;
  /** Signed downloads of attached files (`/assets/*`). Omitted: not mounted. */
  readonly assets?: AssetDeps;
  /**
   * The credential proxy (`/egress/*`), on the MCP runtime: sandbox sessions reach GitHub,
   * Google and ClickUp through it and lose `user_token`. Omitted: off, and Workers keep
   * `user_token` (`SANDBOX_CREDENTIAL_PROXY`).
   */
  readonly credentialProxy?: Omit<EgressDeps, "runtime">;
  /** EXPERIMENTAL: serve built-in skills over MCP (`EXPERIMENTAL_MCP_SKILLS`). */
  readonly experimentalMcpSkills?: boolean;
  /** Account linking (`/connect/*`). Omitted: not mounted. */
  readonly connect?: ConnectDeps;
  /** The Members page's data (`GET /members`), from the auth instance. Omitted: 501. */
  readonly members?: HttpDeps["members"];
  /** Changes a dashboard user's role (`POST /members/:key/role`), from the auth instance. */
  readonly setRole?: HttpDeps["setRole"];
  /** Shared connector accounts (`/shared-accounts`), from the auth instance. Omitted: 501. */
  readonly sharedAccounts?: HttpDeps["sharedAccounts"];
  /** The Email Digest is on: people may switch their mailbox on (`GET/POST /me/email`). */
  readonly emailDigest?: boolean;
  /**
   * Origins a browser may call this API from (the web dashboard when it is served from
   * another origin). Omitted or empty: no CORS headers, so browsers block cross-origin calls.
   * CORS is not authentication: it only stops other sites' pages from reading responses.
   */
  readonly corsOrigins?: ReadonlyArray<string>;
}

/** `WEB_ORIGIN`: comma-separated origins, whitespace and a trailing slash ignored. */
export const parseOrigins = (raw: string | undefined): ReadonlyArray<string> =>
  (raw ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

/**
 * Builds the Coordinator HTTP app. Transport only: routes call core use cases
 * through the provider Layer chosen by the entry file (main.bun.ts / main.cloudflare.ts).
 */
export const createApp = (options: ConstructorParameters<typeof Elysia>[0], deps: AppDeps) => {
  const base = new Elysia(options).onBeforeHandle(async ({ request, route, set }) => {
    if (policyFor(request.method, route) === "worker") {
      return refuseNonWorker(deps.mcp, { request, route, set });
    }
    const denied = await deny(deps.access, request, route);
    if (!denied) return;
    set.status = denied.status;
    return { error: denied.error };
  });
  const withCors = deps.corsOrigins?.length
    ? base.use(
        cors({
          origin: [...deps.corsOrigins],
          methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
          allowedHeaders: ["content-type", "authorization"],
          // Sign-in hands the dashboard its session token in this header.
          exposeHeaders: ["set-auth-token"],
          credentials: false,
        }),
      )
    : base;
  const app = withCors.get("/health", () => ({ status: "ok", service: "coordinator" }));
  const withHttp = deps.http
    ? app.use(
        httpRoutes({
          ...deps.http,
          ...(deps.members && { members: deps.members }),
          ...(deps.setRole && { setRole: deps.setRole }),
          ...(deps.sharedAccounts && { sharedAccounts: deps.sharedAccounts }),
          ...(deps.emailDigest && { emailDigest: true }),
          access: deps.access,
        }),
      )
    : app;
  const withAuth = deps.auth ? withHttp.use(authRoutes(deps.auth)) : withHttp;
  const withConnect = deps.connect ? withAuth.use(connectRoutes(deps.connect)) : withAuth;
  // One storage config: the limits intake applies to a message's files also bound Worker uploads.
  const attachments = deps.http?.inbound?.attachments;
  const withAssets = deps.assets
    ? withConnect.use(assetRoutes({ ...(attachments && { attachments }), ...deps.assets }))
    : withConnect;
  if (!deps.mcp) return withAssets;
  const proxy = deps.credentialProxy;
  const withMcp = withAssets
    .use(
      mcpRoutes(deps.mcp, {
        credentialProxy: proxy !== undefined,
        ...(deps.experimentalMcpSkills && { experimentalSkills: true }),
      }),
    )
    .use(skillRoutes({ runtime: deps.mcp }))
    .use(runRoutes({ runtime: deps.mcp }));
  return proxy ? withMcp.use(egressRoutes({ ...proxy, runtime: deps.mcp })) : withMcp;
};
