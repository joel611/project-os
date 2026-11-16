import { Database } from "bun:sqlite";
import { migrationsFolder } from "@project-os/db-sqlite/migrations-folder";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { UserConnections } from "@project-os/core";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type AuthConfig, makeAuth } from "./auth.ts";
import { Auth } from "./service.ts";

const admin = { email: "ops@example.com", password: "correct horse battery" };

const makeConfig = (extra: Partial<AuthConfig> = {}): AuthConfig => {
  const db = drizzle({ client: new Database(":memory:") });
  migrate(db, { migrationsFolder });
  return { db, secret: "unit-test-secret-unit-test-secret", admin, ...extra };
};

describe("Auth service", () => {
  it("builds from config; ready() seeds the admin", async () => {
    const allowed = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth;
        yield* Effect.promise(() => auth.ready());
        const ctx = yield* Effect.promise(() => auth.auth.$context);
        const found = yield* Effect.promise(() => ctx.internalAdapter.findUserByEmail(admin.email));
        return { admin: found?.user.email, isAllowed: auth.isAllowed(admin.email) };
      }).pipe(Effect.provide(Auth.layer(makeConfig()))),
    );
    expect(allowed).toEqual({ admin: admin.email, isAllowed: true });
  });

  it("wraps an instance built elsewhere", async () => {
    const built = makeAuth(makeConfig());
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Auth;
      }).pipe(Effect.provide(Auth.from(built))),
    );
    expect(got).toBe(built);
  });

  const connections = (config: ReturnType<typeof makeConfig>) =>
    Effect.runPromise(
      Effect.serviceOption(UserConnections).pipe(
        Effect.provide(Auth.connectionsLayer.pipe(Layer.provideMerge(Auth.layer(config)))),
      ),
    );

  it("provides UserConnections when an OAuth client is set", async () => {
    const found = await connections(
      makeConfig({
        baseURL: "http://localhost:8080",
        github: { clientId: "id", clientSecret: "s" },
      }),
    );
    expect(Option.isSome(found)).toBe(true);
  });

  it("provides no UserConnections without an OAuth client", async () => {
    expect(Option.isNone(await connections(makeConfig()))).toBe(true);
  });
});
