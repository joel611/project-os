import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTestD1 } from "../../__tests__/test-d1";
import { D1Binding } from "../../libs/db";
import { Task } from "../task";

describe("Task", () => {
  let d1: Awaited<ReturnType<typeof makeTestD1>>;
  const layer = () =>
    Task.layer.pipe(Layer.provide(Layer.succeed(D1Binding, d1.binding)));

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
      program.pipe(Effect.provide(layer()))
    );

    expect(created.title).toBe("core task test");
    expect(all.length).toBeGreaterThan(0);
  });

  it("updates and then removes a task through D1", async () => {
    const program = Effect.gen(function* program() {
      const repo = yield* Task;
      const created = yield* repo.create("to update");
      const updated = yield* repo.update(created.id, { done: true });
      const removed = yield* repo.remove(created.id);
      return { created, removed, updated };
    });

    const { created, updated, removed } = await Effect.runPromise(
      program.pipe(Effect.provide(layer()))
    );

    expect(updated.done).toBe(true);
    expect(removed.id).toBe(created.id);
  });

  it("fails with a tagged TaskError when updating a missing task", async () => {
    const program = Effect.gen(function* program() {
      const repo = yield* Task;
      return yield* repo.update(999_999, { done: true }).pipe(Effect.flip);
    });

    const error = await Effect.runPromise(
      program.pipe(Effect.provide(layer()))
    );

    expect(error._tag).toBe("TaskError");
  });
});
