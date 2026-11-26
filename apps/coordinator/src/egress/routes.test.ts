import {
  issueSandboxToken,
  ProjectRepository,
  TicketRepository,
  type Ticket,
} from "@project-os/core";
import { makeTestLayer } from "@project-os/testing";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { McpRuntime } from "../mcp/server.ts";
import { type EgressDeps, egressRoutes } from "./routes.ts";

const T0 = "2026-11-04T00:00:00.000Z";
const SANDBOX = "daytona-t1";

const ticket = (id: string): Ticket => ({
  id,
  projectId: "p1",
  status: "in_progress",
  title: id,
  intent: null,
  inputSummary: "",
  priority: null,
  workerType: "daytona_pi",
  workerId: SANDBOX,
  requester: null,
  result: null,
  error: null,
  createdAt: T0,
  assignedAt: T0,
  startedAt: T0,
  lastActivityAt: T0,
  completedAt: null,
  updatedAt: T0,
});

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let runtime: ManagedRuntime.ManagedRuntime<any, never>;
let token: string;
let sent: Sent[];
let reply: () => Response;

const fakeFetch = (async (input: URL, init: RequestInit) => {
  sent.push({
    url: String(input),
    method: init.method!,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: init.body ? await new Response(init.body).text() : "",
  });
  return reply();
}) as unknown as typeof fetch;

/** Seeds Ada's ticket t1 on the sandbox, Ada linked to GitHub, and returns the sandbox token. */
const setUp = async (options: { readonly adaLinked?: boolean; readonly tickets?: number } = {}) => {
  const t = makeTestLayer();
  if (options.adaLinked !== false) {
    t.link({ channelType: "discord", id: "u-ada" }, "github", "gho-ada");
  }
  runtime = ManagedRuntime.make(t.layer);
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert({
        id: "p1",
        orgId: "o1",
        name: "Acme",
        slug: null,
        customInstructions: "",
        defaultResponseChannelId: null,
        channelDigest: true,
        channelDigestNotify: false,
        status: "active",
        createdBy: null,
        createdAt: T0,
        updatedAt: T0,
      });
      const tickets = yield* TicketRepository;
      for (let n = 1; n <= (options.tickets ?? 1); n++) {
        yield* tickets.insert(ticket(`t${n}`));
        yield* tickets.appendEvent({
          id: `e${n}`,
          ticketId: `t${n}`,
          type: "created",
          actor: "coordinator",
          actorId: null,
          body: "",
          payload: { sender: { id: "u-ada", name: "Ada" }, channelType: "discord" },
          createdAt: T0,
        });
      }
      return yield* issueSandboxToken(SANDBOX, 600);
    }) as Effect.Effect<string, never, any>,
  );
};

const app = (deps: Partial<EgressDeps> = {}) =>
  egressRoutes({
    runtime: runtime as unknown as McpRuntime,
    origins: { github: "https://gh.test", "github-git": "https://git.test" },
    fetch: fakeFetch,
    ...deps,
  });

const call = (
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  deps?: Partial<EgressDeps>,
) =>
  app(deps).handle(
    new Request(`http://coord.test${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      ...(init.body !== undefined && { body: init.body }),
    }),
  );

beforeEach(async () => {
  sent = [];
  reply = () => Response.json({ ok: true });
  token = await setUp();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await runtime.dispose();
});

describe("credential proxy", () => {
  it("forwards with the requester's token in place of the sandbox's own", async () => {
    const res = await call("/egress/github/repos/acme/web/pulls?state=open", {
      method: "POST",
      headers: {
        cookie: "sid=1",
        "accept-encoding": "gzip",
        "x-project-os-ticket": "t1",
        accept: "application/vnd.github+json",
      },
      body: '{"title":"x"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const [out] = sent;
    expect(out!.url).toBe("https://gh.test/repos/acme/web/pulls?state=open");
    expect(out!.method).toBe("POST");
    expect(out!.body).toBe('{"title":"x"}');
    expect(out!.headers.authorization).toBe("Bearer gho-ada");
    expect(out!.headers.accept).toBe("application/vnd.github+json");
    for (const gone of ["cookie", "accept-encoding", "x-project-os-ticket"]) {
      expect(out!.headers[gone]).toBeUndefined();
    }
  });

  it("signs git over HTTPS the way GitHub wants", async () => {
    await call("/egress/github-git/acme/web.git/info/refs?service=git-upload-pack");
    expect(sent[0]!.url).toBe("https://git.test/acme/web.git/info/refs?service=git-upload-pack");
    expect(sent[0]!.headers.authorization).toBe(`Basic ${btoa("x-access-token:gho-ada")}`);
  });

  it("goes to the real provider when no origin is overridden", async () => {
    const real = vi.fn(fakeFetch);
    vi.stubGlobal("fetch", real);
    await egressRoutes({ runtime: runtime as unknown as McpRuntime }).handle(
      new Request("http://coord.test/egress/github/user", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(real).toHaveBeenCalledOnce();
    expect(sent[0]!.url).toBe("https://api.github.com/user");
  });

  it("refuses unknown services and paths that leave the provider", async () => {
    const unknown = await call("/egress/toString/x");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "UnknownService" });
    const escape = await call("/egress/github//evil.test/steal");
    expect(escape.status).toBe(400);
    expect(await escape.json()).toMatchObject({ error: "InvalidPath" });
    expect(sent).toEqual([]);
  });

  it("says NotConnected when the requester hasn't linked the provider", async () => {
    await runtime.dispose();
    token = await setUp({ adaLinked: false });
    const res = await call("/egress/github/user");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "NotConnected" });
    expect(sent).toEqual([]);
  });

  it("asks which ticket when the worker holds several, and 404s a missing one", async () => {
    await runtime.dispose();
    token = await setUp({ tickets: 2 });
    const unsure = await call("/egress/github/user");
    expect(unsure.status).toBe(403);
    expect(await unsure.json()).toMatchObject({ error: "EgressTicketUnknown" });
    const missing = await call("/egress/github/user", { headers: { "x-project-os-ticket": "t9" } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "TicketNotFound" });
    const named = await call("/egress/github/user", { headers: { "x-project-os-ticket": "t2" } });
    expect(named.status).toBe(200);
  });

  it("keeps same-provider redirects on the proxy and strips what can't pass through", async () => {
    reply = () =>
      new Response(null, {
        status: 301,
        headers: {
          location: "https://gh.test/repositories/42?page=2",
          "set-cookie": "a=b",
          "x-ratelimit-remaining": "59",
        },
      });
    const moved = await call("/egress/github/repos/acme/old");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/egress/github/repositories/42?page=2");
    expect(moved.headers.get("set-cookie")).toBeNull();
    expect(moved.headers.get("x-ratelimit-remaining")).toBe("59");

    reply = () =>
      new Response(null, { status: 302, headers: { location: "https://codeload.test/zip" } });
    const away = await call("/egress/github/repos/acme/web/zipball");
    expect(away.headers.get("location")).toBe("https://codeload.test/zip");
  });
});
