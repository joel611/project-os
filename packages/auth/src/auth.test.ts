import { Database } from "bun:sqlite";
import { migrationsFolder } from "@project-os/db-sqlite/migrations-folder";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { describe, expect, it } from "vite-plus/test";
import { type AuthConfig, makeAuth } from "./auth.ts";

const BASE = "http://localhost:8080";
const admin = { email: "Ops@Example.com", password: "correct horse battery" };

const authWith = (config: Partial<AuthConfig> = {}) => {
  const db = drizzle({ client: new Database(":memory:") });
  migrate(db, { migrationsFolder });
  return makeAuth({ db, baseURL: BASE, secret: "unit-test-secret-unit-test-secret", ...config });
};

const post = (auth: ReturnType<typeof authWith>, path: string, body: unknown) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("makeAuth", () => {
  it("signs the seeded admin in with a bearer session token", async () => {
    const auth = authWith({ admin });
    const res = await post(auth, "/sign-in/email", {
      email: "ops@example.com",
      password: admin.password,
    });
    expect(res.status).toBe(200);
    const token = res.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    expect(await auth.sessionUser(token!)).toMatchObject({ email: "ops@example.com" });
  });

  it("refuses a wrong password and an unknown token", async () => {
    const auth = authWith({ admin });
    const res = await post(auth, "/sign-in/email", { email: admin.email, password: "nope-nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-auth-token")).toBeNull();
    expect(await auth.sessionUser("not-a-session")).toBeUndefined();
  });

  it("lets nobody in without a seeded admin", async () => {
    const auth = authWith();
    await auth.ready();
    expect((await post(auth, "/sign-in/email", admin)).status).toBe(401);
  });

  it("has no sign-up", async () => {
    const auth = authWith({ admin });
    const res = await post(auth, "/sign-up/email", {
      email: "new@example.com",
      password: "long enough password",
      name: "New",
    });
    expect(res.ok).toBe(false);
    const signIn = await post(auth, "/sign-in/email", {
      email: "new@example.com",
      password: "long enough password",
    });
    expect(signIn.status).toBe(401);
  });

  it("seeds the admin once, however often it boots", async () => {
    const db = drizzle({ client: new Database(":memory:") });
    migrate(db, { migrationsFolder });
    const config = { db, baseURL: BASE, secret: "unit-test-secret-unit-test-secret", admin };
    await makeAuth(config).ready();
    const second = makeAuth(config);
    await second.ready();
    const res = await post(second, "/sign-in/email", admin);
    expect(res.status).toBe(200);
  });

  it("signs out: the token stops working", async () => {
    const auth = authWith({ admin });
    const token = (await post(auth, "/sign-in/email", admin)).headers.get("set-auth-token")!;
    const out = await auth.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(out.status).toBe(200);
    expect(await auth.sessionUser(token)).toBeUndefined();
  });

  it("allows the admin and listed emails, in any case", () => {
    const auth = authWith({ admin, allowedEmails: ["Ada@Example.com "] });
    expect(auth.isAllowed("ops@example.com")).toBe(true);
    expect(auth.isAllowed("ADA@example.com")).toBe(true);
    expect(auth.isAllowed("eve@example.com")).toBe(false);
  });

  it("links accounts only when a provider and the public URL are set", () => {
    const google = { clientId: "id", clientSecret: "secret" };
    expect(authWith().connections).toBeUndefined();
    expect(authWith({ google }).connections).toBeDefined();
    const db = drizzle({ client: new Database(":memory:") });
    const noUrl = makeAuth({ db, secret: "unit-test-secret-unit-test-secret", google });
    expect(noUrl.connections).toBeUndefined();
  });
});
