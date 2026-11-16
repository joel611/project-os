import { Database } from "bun:sqlite";
import { migrationsFolder } from "@project-os/db-sqlite/migrations-folder";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeAuth } from "./auth.ts";
import { Auth } from "./service.ts";

const admin = { email: "ops@example.com", password: "correct horse battery" };

const config = () => {
  const db = drizzle({ client: new Database(":memory:") });
  migrate(db, { migrationsFolder });
  return { db, secret: "unit-test-secret-unit-test-secret", admin };
};

describe("Auth service", () => {
  it("builds from config and seeds the admin before use", async () => {
    const allowed = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const ctx = yield* Effect.promise(() => auth.auth.$context);
        const found = yield* Effect.promise(() => ctx.internalAdapter.findUserByEmail(admin.email));
        return { admin: found?.user.email, isAllowed: auth.isAllowed(admin.email) };
      }).pipe(Effect.provide(Auth.layer(config()))),
    );
    expect(allowed).toEqual({ admin: admin.email, isAllowed: true });
  });

  it("wraps an instance built elsewhere", async () => {
    const built = makeAuth(config());
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Auth;
      }).pipe(Effect.provide(Auth.from(built))),
    );
    expect(got).toBe(built);
  });
});
