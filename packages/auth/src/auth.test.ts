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

describe("makeAuth members", () => {
  it("takes no session user for a member unless it is a channel identity", async () => {
    const auth = authWith({ admin });
    expect(
      await auth.memberPerson({ userId: "u", email: "ops@example.com", name: "Ops" }),
    ).toBeUndefined();
  });

  it("finds no linked person for a password-only operator", async () => {
    const auth = authWith({ admin });
    const res = await post(auth, "/sign-in/email", admin);
    const user = await auth.sessionUser(res.headers.get("set-auth-token")!);
    expect(await auth.linkedPerson(user!.userId)).toBeUndefined();
  });

  it("refuses to create a user who is neither an operator nor a channel identity", async () => {
    const auth = authWith({ admin });
    const ctx = await auth.auth.$context;
    // The hook says no: nothing is created.
    const created = await ctx.internalAdapter.createUser(
      { email: "eve@example.com", name: "Eve", emailVerified: true },
      { method: "test" },
    );
    expect(created).toBeNull();
    expect(await ctx.internalAdapter.findUserByEmail("eve@example.com")).toBeNull();
  });
});

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

  it("signs in from the dashboard's own origin, cross-site, and from no other", async () => {
    const auth = authWith({ admin, webOrigins: ["https://dash.example"] });
    const fromBrowser = (origin: string) =>
      auth.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
          },
          body: JSON.stringify(admin),
        }),
      );
    const dashboard = await fromBrowser("https://dash.example");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("set-auth-token")).toBeTruthy();
    const elsewhere = await fromBrowser("https://evil.example");
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get("set-auth-token")).toBeNull();
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

  it("adds the admin password to a user who signed in with Google first", async () => {
    const db = drizzle({ client: new Database(":memory:") });
    migrate(db, { migrationsFolder });
    const config = { db, baseURL: BASE, secret: "unit-test-secret-unit-test-secret" };
    const ctx = await makeAuth({ ...config, allowedEmails: [admin.email] }).auth.$context;
    const google = await ctx.internalAdapter.createUser(
      { email: "ops@example.com", name: "Ops", emailVerified: true },
      { method: "oauth", oauth: { providerId: "google-signin" } },
    );
    await ctx.internalAdapter.linkAccount({
      providerId: "google-signin",
      accountId: "google-ops",
      userId: google.id,
    });

    const auth = makeAuth({ ...config, admin });
    const token = (await post(auth, "/sign-in/email", admin)).headers.get("set-auth-token")!;
    expect((await auth.sessionUser(token))?.userId).toBe(google.id);
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

  it("with domains, allows anyone at them and the admin, and no listed email outside them", () => {
    const auth = authWith({
      admin,
      allowedEmails: ["ada@example.com", "bob@acme.com"],
      allowedDomains: ["@Acme.com ", "acme.io"],
    });
    expect(auth.isAllowed("eve@ACME.com")).toBe(true);
    expect(auth.isAllowed("bob@acme.com")).toBe(true);
    expect(auth.isAllowed("zed@acme.io")).toBe(true);
    expect(auth.isAllowed("ops@example.com")).toBe(true);
    expect(auth.isAllowed("ada@example.com")).toBe(false);
    expect(auth.isAllowed("eve@notacme.com")).toBe(false);
    expect(auth.isAllowed("eve@sub.acme.com")).toBe(false);
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
