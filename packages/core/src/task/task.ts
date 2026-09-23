import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Db } from "../libs/db";
import { TaskError } from "./task-error";
import { task } from "./task-schema";

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new TaskError({ cause }),
    try: run,
  });

const firstRow = <A>(rows: A[]) =>
  rows[0]
    ? Effect.succeed(rows[0])
    : Effect.fail(new TaskError({ cause: "no matching row" }));

export class Task extends Context.Service<Task>()("Task", {
  make: Effect.gen(function* make() {
    const db = yield* Db;

    return {
      create: (title: string) =>
        attempt(() => db.insert(task).values({ title }).returning()).pipe(
          Effect.flatMap(firstRow)
        ),
      list: () => attempt(() => db.select().from(task)),
      remove: (id: number) =>
        attempt(() => db.delete(task).where(eq(task.id, id)).returning()).pipe(
          Effect.flatMap(firstRow)
        ),
      update: (id: number, changes: { title?: string; done?: boolean }) =>
        attempt(() =>
          db.update(task).set(changes).where(eq(task.id, id)).returning()
        ).pipe(Effect.flatMap(firstRow)),
    };
  }),
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make);
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(Db.layer));
}
