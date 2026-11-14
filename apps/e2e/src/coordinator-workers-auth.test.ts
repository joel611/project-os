import { readFileSync } from "node:fs";
import { makeAssetStore } from "@project-os/infra-local/shared";
import { Effect } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

// The Cloudflare Coordinator entry (main.cloudflare.ts) in workerd (Miniflare), with D1 and KV:
// the guard, Better Auth on D1, and the admin seeded on the first /api/auth request, since a
// Worker does no I/O at module load. Every outbound fetch is refused.

const migration = readFileSync(
  new URL(
    "../../../packages/db-sqlite/migrations/20261107121658_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

const ADMIN = { email: "ops@project-os.test", password: "ops-password" };
const SERVICE_TOKEN = "workers-service-token";
const SECRET = "workers-secret-workers-secret-workers";

let script: string;
const instances: Miniflare[] = [];

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [new URL("../../coordinator/src/main.cloudflare.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["workerd", "worker", "import"],
    format: "esm",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  script = await built.outputs[0]!.text();
}, 60_000);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((mf) => mf.dispose().catch(() => undefined)));
});

const without = (keys: ReadonlyArray<string>, env: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));

const boot = async (unset: ReadonlyArray<string> = []) => {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "coordinator.js", contents: script }],
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: without(unset, {
      BETTER_AUTH_SECRET: SECRET,
      COORDINATOR_SERVICE_TOKEN: SERVICE_TOKEN,
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      PUBLIC_URL: "http://coordinator.test",
      DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
    }),
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["ASSETS"],
    durableObjects: { PI_AGENT: { className: "PiAgent", useSQLite: true } },
    outboundService: () =>
      new Response("blocked: the test makes no outbound requests", { status: 502 }),
  });
  instances.push(mf);
  const db = await mf.getD1Database("DB");
  for (const statement of migration.split("--> statement-breakpoint")) {
    await db.prepare(statement).run();
  }
  const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    mf.dispatchFetch(`http://coordinator.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.token && { authorization: `Bearer ${init.token}` }),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
  return { call, mf };
};

describe("Coordinator on Workers", () => {
  it("refuses the API without credentials and serves the seeded admin", async () => {
    const { call } = await boot();
    expect((await call("/health")).status).toBe(200);
    expect((await call("/projects")).status).toBe(401);
    expect((await call("/mcp", { method: "POST", body: {} })).status).toBe(401);

    const signIn = await call("/api/auth/sign-in/email", { method: "POST", body: ADMIN });
    expect(signIn.status).toBe(200);
    const token = signIn.headers.get("set-auth-token")!;
    const projects = await call("/projects", { token });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual([]);
  }, 30_000);

  it("does not start without its secrets or its default model", async () => {
    for (const secret of ["BETTER_AUTH_SECRET", "COORDINATOR_SERVICE_TOKEN", "DEFAULT_MODEL"]) {
      await expect(boot([secret])).rejects.toThrow();
    }
  }, 30_000);

  it("serves /assets without a login, and refuses a link whose signature is wrong", async () => {
    const { call } = await boot();
    // Public like /connect: the signature is the credential. A wrong one is 403, not 401.
    const res = await call("/assets/t1/a1/hero.png?exp=9999999999&sig=wrong");
    expect(res.status).toBe(403);
  }, 30_000);

  it("streams a stored file from R2 for a validly signed link", async () => {
    const { mf } = await boot();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await (
      await mf.getR2Bucket("ASSETS")
    ).put("t1/a1/hero.png", bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    // A link minted the way the Coordinator does, with the Worker's BETTER_AUTH_SECRET.
    const link = await Effect.runPromise(
      makeAssetStore({
        backend: { put: async () => {}, get: async () => undefined },
        links: { publicUrl: "http://coordinator.test", secret: SECRET },
      }).link("t1/a1/hero.png"),
    );

    const res = await mf.dispatchFetch(link!);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''hero.png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    // A correctly signed link to a key nobody stored: past the check, nothing there.
    const missing = await Effect.runPromise(
      makeAssetStore({
        backend: { put: async () => {}, get: async () => undefined },
        links: { publicUrl: "http://coordinator.test", secret: SECRET },
      }).link("t1/a1/missing.png"),
    );
    expect((await mf.dispatchFetch(missing!)).status).toBe(404);
  }, 30_000);

  it("takes commands only with the service token", async () => {
    const { call } = await boot();
    expect((await call("/commands", { method: "POST", body: {} })).status).toBe(401);
    // Past the guard, the route itself rejects the empty command.
    const withToken = await call("/commands", { method: "POST", body: {}, token: SERVICE_TOKEN });
    expect(withToken.status).toBe(400);
  }, 30_000);
});
