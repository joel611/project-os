import { Context, Effect, Layer } from "effect";
import { type AuthApi, type AuthConfig, makeAuth } from "./auth.ts";

/**
 * The Coordinator's Better Auth as an Effect service, so code that needs sessions or account
 * links gets it with `yield* Auth` and a test swaps the layer. `makeAuth` stays the plain
 * constructor for entrypoints that build it before any runtime exists.
 */
export class Auth extends Context.Service<Auth, AuthApi>()("@project-os/auth/Auth") {
  /**
   * Builds the instance from `config` over the Drizzle db it carries, and seeds the admin
   * before anything uses it.
   */
  static readonly layer = (config: AuthConfig): Layer.Layer<Auth> =>
    Layer.effect(
      Auth,
      Effect.promise(async () => {
        const auth = makeAuth(config);
        await auth.ready();
        return auth;
      }),
    );

  /** Wraps an instance built elsewhere (an entrypoint's `makeAuth`, or a test's). */
  static readonly from = (auth: AuthApi): Layer.Layer<Auth> => Layer.succeed(Auth, auth);
}
