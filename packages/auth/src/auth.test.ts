import { Database } from "bun:sqlite";
import { schema } from "@project-os/db-sqlite";
import { migrationsFolder } from "@project-os/db-sqlite/migrations-folder";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { describe, expect, it } from "vite-plus/test";
import { type AuthConfig, GOOGLE_SIGN_IN } from "./auth.ts";
import { authOf } from "./test-auth.ts";

const BASE = "http://localhost:8080";
const admin = { email: "Ops@Example.com", password: "correct horse battery" };

const authWith = (config: Partial<AuthConfig> = {}) => {
  const db = drizzle({ client: new Database(":memory:") });
  migrate(db, { migrationsFolder });
  return authOf({ baseURL: BASE, secret: "unit-test-secret-unit-test-secret", db, ...config });
};

const post = (auth: ReturnType<typeof authWith>, path: string, body: unknown) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("Auth members", () => {
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

describe("Auth", () => {
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
    await authOf(config).ready();
    const second = authOf(config);
    await second.ready();
    const res = await post(second, "/sign-in/email", admin);
    expect(res.status).toBe(200);
  });

  it("adds the admin password to a user who signed in with Google first", async () => {
    const db = drizzle({ client: new Database(":memory:") });
    migrate(db, { migrationsFolder });
    const config = { db, baseURL: BASE, secret: "unit-test-secret-unit-test-secret" };
    const ctx = await authOf({ ...config, allowedEmails: [admin.email] }).auth.$context;
    const google = await ctx.internalAdapter.createUser(
      { email: "ops@example.com", name: "Ops", emailVerified: true },
      { method: "oauth", oauth: { providerId: "google-signin" } },
    );
    await ctx.internalAdapter.linkAccount({
      providerId: "google-signin",
      accountId: "google-ops",
      userId: google.id,
    });

    const auth = authOf({ ...config, admin });
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
    const noUrl = authOf({ db, secret: "unit-test-secret-unit-test-secret", google });
    expect(noUrl.connections).toBeUndefined();
  });
});

describe("Auth member list", () => {
  const CHANNEL = "@people.project-os.invalid";

  it("lists the password operator alone, with no sign-in yet and nothing linked", async () => {
    const auth = authWith({ admin });
    await auth.ready();
    expect(await auth.members()).toEqual([
      {
        key: expect.any(String),
        name: "Admin",
        email: "ops@example.com",
        admin: true,
        dashboard: { lastSignInAt: null },
        channel: null,
        googleLinked: false,
        github: null,
      },
    ]);
  });

  it("pairs a Google sign-in with the channel identity that linked the same account", async () => {
    const db = drizzle({ client: new Database(":memory:") });
    migrate(db, { migrationsFolder });
    const auth = authWith({ admin, allowedEmails: ["ada@example.com"], db });
    await auth.ready();
    const ctx = await auth.auth.$context;
    // Straight into the table: linking a Google or GitHub account normally goes through /connect.
    const link = async (userId: string, providerId: string, accountId: string) => {
      const now = new Date();
      await db.insert(schema.account).values({
        id: `${userId}-${providerId}`,
        userId,
        providerId,
        accountId,
        createdAt: now,
        updatedAt: now,
      });
    };
    const user = (email: string, name: string) =>
      ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "test" });

    // Ada: dashboard sign-in and a Discord identity, same Google sub; GitHub on the Discord side.
    const dash = await user("ada@example.com", "Ada Lovelace");
    await link(dash.id, GOOGLE_SIGN_IN, "sub-ada");
    await ctx.internalAdapter.createSession(dash.id);
    await ctx.internalAdapter.createSession(dash.id);
    const discordAda = await user(`discord-u-ada${CHANNEL}`, "Ada");
    await link(discordAda.id, "google", "sub-ada");
    await link(discordAda.id, "github", "gh-1");
    // Bob: a Discord member who signed in as themselves; no GitHub.
    const bob = await user(`discord-u-bob${CHANNEL}`, "Bob");
    await link(bob.id, "google", "sub-bob");
    await link(bob.id, GOOGLE_SIGN_IN, "member:sub-bob");
    await ctx.internalAdapter.createSession(bob.id);
    // Nameless: a Discord user known only by id, who linked nothing.
    await user(`discord-u-zed${CHANNEL}`, "u-zed");

    const list = await auth.members();
    expect(list.map((m) => m.name)).toEqual(["Ada Lovelace", "Admin", "Bob", "u-zed"]);
    const [ada, , bobRow, zed] = list;
    expect(ada).toMatchObject({
      admin: true,
      googleLinked: true,
      dashboard: { lastSignInAt: expect.any(String) },
      channel: { type: "discord", id: "u-ada", name: "Ada" },
      github: { login: null },
    });
    expect(bobRow).toMatchObject({
      admin: false,
      email: null,
      googleLinked: true,
      dashboard: { lastSignInAt: expect.any(String) },
      channel: { id: "u-bob" },
      github: null,
    });
    expect(zed).toMatchObject({
      channel: { id: "u-zed", name: null },
      dashboard: null,
      googleLinked: false,
    });
    // Ada is one row: her Discord identity is not listed again.
    expect(list).toHaveLength(4);
  });
});
