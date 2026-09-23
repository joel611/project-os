import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTestD1 } from "../../../__tests__/test-d1";
import { Db } from "../client";
import { D1Binding } from "../d1-binding";
import { task } from "../schema";

describe("Db layer", () => {
  let d1: Awaited<ReturnType<typeof makeTestD1>>;

  beforeAll(async () => {
    d1 = await makeTestD1();
  });

  afterAll(() => d1.dispose());

  it("round-trips a row through the DI-provided drizzle instance", async () => {
    const program = Effect.gen(function* program() {
      const db = yield* Db;
      const [inserted] = yield* Effect.tryPromise(() =>
        db.insert(task).values({ title: "vitest row" }).returning()
      );
      const rows = yield* Effect.tryPromise(() => db.select().from(task));
      return { inserted, rows };
    });

    const { inserted, rows } = await Effect.runPromise(
      program.pipe(
        Effect.provide(Db.layer),
        Effect.provide(Layer.succeed(D1Binding, d1.binding))
      )
    );

    expect(inserted).toMatchObject({ done: false, title: "vitest row" });
    expect(rows.length).toBeGreaterThan(0);
  });
});
