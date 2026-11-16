import { DrizzleSqlite } from "@project-os/db-sqlite";
import { Context, Effect, Layer } from "effect";
import { type AuthApi, type AuthSettings, makeAuth } from "./auth.ts";

/**
 * The Coordinator's Better Auth as an Effect service, so code that needs sessions or account
 * links gets it with `yield* Auth` and a test swaps the layer.
 */
export class Auth extends Context.Service<Auth, AuthApi>()("@project-os/auth/Auth") {
  /**
   * Builds the instance from `settings` over the `DrizzleSqlite` in scope, so auth and the
   * repositories share one handle. Synchronous, because the Worker builds its app at module
   * load. The admin is seeded on the first request, or by `auth.ready()` at boot.
   */
  static readonly layer = (settings: AuthSettings): Layer.Layer<Auth, never, DrizzleSqlite> =>
    Layer.effect(
      Auth,
      Effect.map(Effect.service(DrizzleSqlite), (db) => makeAuth({ ...settings, db })),
    );

  /** Wraps an instance built elsewhere, such as a test's. */
  static readonly from = (auth: AuthApi): Layer.Layer<Auth> => Layer.succeed(Auth, auth);

  /** `UserConnections` when account linking is configured, nothing otherwise. */
  static readonly connectionsLayer = Layer.unwrap(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return auth.connections?.layer ?? Layer.empty;
    }),
  );
}
