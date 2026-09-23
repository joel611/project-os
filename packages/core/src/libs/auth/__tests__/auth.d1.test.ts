import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTestD1 } from "../../../__tests__/test-d1";
import { D1Binding } from "../../db";
import { Auth } from "../auth";

const unique = (label: string) => `${label}-${crypto.randomUUID()}@example.com`;
const password = "correct-horse-battery";
const layerFor = (binding: D1Database) =>
  Auth.layer.pipe(Layer.provide(Layer.succeed(D1Binding, binding)));

describe("Auth over the D1-backed drizzleAdapter", () => {
  let d1: Awaited<ReturnType<typeof makeTestD1>>;
  let layer: ReturnType<typeof layerFor>;

  beforeAll(async () => {
    d1 = await makeTestD1();
    layer = layerFor(d1.binding);
  });

  afterAll(() => d1.dispose());

  it("signs up, signs in and reads the session back through D1", async () => {
    const email = unique("d1");
    const program = Effect.gen(function* program() {
      const auth = yield* Auth;
      const signedUp = yield* auth.signUpEmail({
        email,
        name: "D1 User",
        password,
      });
      const signedIn = yield* Effect.promise(() =>
        auth.instance.api.signInEmail({
          body: { email, password },
          returnHeaders: true,
        })
      );
      const cookie = signedIn.headers.getSetCookie().join("; ");
      const session = yield* auth.getSession(new Headers({ cookie }));
      return { session, signedIn, signedUp };
    });

    const { signedUp, signedIn, session } = await Effect.runPromise(
      program.pipe(Effect.provide(layer))
    );

    expect(signedUp.user.email).toBe(email);
    expect(signedIn.response.user.id).toBe(signedUp.user.id);
    expect(session?.user.id).toBe(signedUp.user.id);
  });

  it("fails with a tagged AuthError on a wrong password", async () => {
    const email = unique("d1-wrong");
    const program = Effect.gen(function* program() {
      const auth = yield* Auth;
      yield* auth.signUpEmail({ email, name: "D1 User", password });
      return yield* auth
        .signInEmail({ email, password: "nope-nope-nope" })
        .pipe(Effect.flip);
    });

    const error = await Effect.runPromise(program.pipe(Effect.provide(layer)));

    expect(error._tag).toBe("AuthError");
  });
});
