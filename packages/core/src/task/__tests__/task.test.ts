import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTestD1 } from "../../__tests__/test-d1";
import { D1Binding } from "../../libs/db";
import { Task } from "../task";

describe("Task", () => {
  let d1: Awaited<ReturnType<typeof makeTestD1>>;

  beforeAll(async () => {
    d1 = await makeTestD1();
  });

  afterAll(() => d1.dispose());

  it("creates a task and lists it back through D1", async () => {
    const program = Effect.gen(function* program() {
      const repo = yield* Task;
      const created = yield* repo.create("core task test");
      const all = yield* repo.list();
      return { all, created };
    });

    const { created, all } = await Effect.runPromise(
      program.pipe(
        Effect.provide(Task.layer),
        Effect.provide(Layer.succeed(D1Binding, d1.binding))
      )
    );

    expect(created.title).toBe("core task test");
    expect(all.length).toBeGreaterThan(0);
  });
});
