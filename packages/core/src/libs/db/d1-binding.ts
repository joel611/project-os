import * as Context from "effect/Context";

export class D1Binding extends Context.Service<D1Binding, D1Database>()(
  "D1Binding"
) {}
