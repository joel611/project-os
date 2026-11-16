import type { ConnectionProvider } from "@project-os/contracts";
import { authenticateCaller, egressAccessToken } from "@project-os/core";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { bearerToken } from "../access.ts";
import type { McpRuntime } from "../mcp/server.ts";

/** Where the credential proxy forwards, and how the person's token goes on the request. */
export interface EgressUpstream {
  readonly origin: string;
  readonly provider: ConnectionProvider;
  /** `bearer`: `Authorization: Bearer <token>`. `git`: Basic `x-access-token:<token>` (GitHub git over HTTPS). */
  readonly auth: "bearer" | "git";
}

export type EgressService = "github" | "github-git" | "google" | "clickup";

/** `/egress/<service>/<path>` goes to `<origin>/<path>`. */
export const EGRESS_UPSTREAMS: Readonly<Record<EgressService, EgressUpstream>> = {
  github: { origin: "https://api.github.com", provider: "github", auth: "bearer" },
  "github-git": { origin: "https://github.com", provider: "github", auth: "git" },
  google: { origin: "https://www.googleapis.com", provider: "google", auth: "bearer" },
  clickup: { origin: "https://api.clickup.com", provider: "clickup", auth: "bearer" },
};

/** Names a ticket when the caller holds several (a Watcher device). Never forwarded. */
export const EGRESS_TICKET_HEADER = "x-project-os-ticket";

export interface EgressDeps {
  readonly runtime: McpRuntime;
  /** Origins to use in place of the real ones (tests point these at localhost). */
  readonly origins?: Partial<Record<EgressService, string>>;
  readonly fetch?: typeof fetch;
}

// Hop-by-hop headers, the caller's own credentials, and what the runtime sets itself.
const DROP_REQUEST = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  // fetch decodes compressed bodies but keeps the header, so ask for plain bodies instead.
  "accept-encoding",
  EGRESS_TICKET_HEADER,
]);
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

const refuse = (status: number, error: string, message: string) =>
  Response.json({ error, message }, { status });

const authorization = (upstream: EgressUpstream, token: string) =>
  upstream.auth === "git" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`;

/**
 * The credential proxy: a Worker calls `/egress/<service>/<path>` with its own MCP Bearer, and
 * the Coordinator forwards the call to the provider with the requesting person's OAuth token in
 * its place. The token never reaches the Worker, so it never enters the model's context.
 */
export const egressRoutes = (deps: EgressDeps) => {
  const send = deps.fetch ?? fetch;
  return new Elysia({ name: "egress" }).all(
    "/egress/:service/*",
    async ({ request, params }) => {
      const token = bearerToken(request);
      const caller = token ? await deps.runtime.runPromise(authenticateCaller(token)) : undefined;
      if (!caller) return refuse(401, "Unauthorized", "Send your MCP token as a Bearer token.");

      const service = params.service as EgressService;
      const upstream = Object.hasOwn(EGRESS_UPSTREAMS, service)
        ? EGRESS_UPSTREAMS[service]
        : undefined;
      if (!upstream) {
        const known = Object.keys(EGRESS_UPSTREAMS).join(", ");
        return refuse(
          404,
          "UnknownService",
          `No egress service "${service}". Use one of ${known}.`,
        );
      }
      const origin = deps.origins?.[service] ?? upstream.origin;
      const incoming = new URL(request.url);
      const prefix = `/egress/${service}`;
      const target = new URL(`${incoming.pathname.slice(prefix.length)}${incoming.search}`, origin);
      // `//host/...` would resolve to another origin: only the service's own host is allowed.
      if (target.origin !== new URL(origin).origin) {
        return refuse(400, "InvalidPath", `The path must stay on ${upstream.origin}.`);
      }

      const ticketId = request.headers.get(EGRESS_TICKET_HEADER) ?? undefined;
      const outcome = await deps.runtime.runPromise(
        egressAccessToken({
          caller,
          provider: upstream.provider,
          ...(ticketId && { ticketId }),
        }).pipe(
          Effect.map((accessToken) => ({ ok: true as const, accessToken })),
          Effect.catch((e: { _tag: string; message?: string }) =>
            Effect.succeed({ ok: false as const, tag: e._tag, message: e.message || e._tag }),
          ),
        ),
      );
      if (!outcome.ok) {
        // NotConnected: the person has already been asked to /connect, as with user_token.
        return refuse(outcome.tag === "TicketNotFound" ? 404 : 403, outcome.tag, outcome.message);
      }

      const headers = new Headers();
      request.headers.forEach((value, key) => {
        if (!DROP_REQUEST.has(key)) headers.set(key, value);
      });
      headers.set("authorization", authorization(upstream, outcome.accessToken));
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const response = await send(target, {
        method: request.method,
        headers,
        redirect: "manual",
        ...(hasBody && { body: request.body, duplex: "half" }),
      } as RequestInit);

      const out = new Headers();
      response.headers.forEach((value, key) => {
        if (!DROP_RESPONSE.has(key)) out.set(key, value);
      });
      // A redirect within the provider stays on the proxy, so the next hop carries the token too.
      const location = response.headers.get("location");
      if (location) {
        const next = new URL(location, target);
        if (next.origin === target.origin) {
          out.set("location", `${prefix}${next.pathname}${next.search}`);
        }
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: out,
      });
    },
    { parse: "none" },
  );
};
