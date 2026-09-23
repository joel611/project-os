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

export class Task extends Context.Service<Task>()("Task", {
  make: Effect.gen(function* make() {
    const db = yield* Db;

    return {
      create: (title: string) =>
        attempt(() => db.insert(task).values({ title }).returning()).pipe(
          Effect.flatMap(([row]) =>
            row
              ? Effect.succeed(row)
              : Effect.fail(new TaskError({ cause: "insert returned no rows" }))
          )
        ),
      list: () => attempt(() => db.select().from(task)),
    };
  }),
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make);
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(Db.layer));
}
