import { drizzle } from "drizzle-orm/d1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { authRelations } from "../auth/auth-schema";
import { D1Binding } from "./d1-binding";

export class Db extends Context.Service<Db>()("Db", {
  make: Effect.gen(function* make() {
    const binding = yield* D1Binding;
    return drizzle(binding, { relations: authRelations });
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
