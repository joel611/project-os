import { Auth, D1Binding, Task } from "core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

interface Bindings {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
}

const makeAppLayer = (env: Bindings) =>
  Layer.mergeAll(Task.layer, Auth.layer).pipe(
    Layer.provide(Layer.succeed(D1Binding, env.DB)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: env.BETTER_AUTH_URL,
        })
      )
    )
  );

type AppRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof makeAppLayer>>,
  Layer.Error<ReturnType<typeof makeAppLayer>>
>;

interface Variables {
  runtime: AppRuntime;
}

export const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const withRuntime = createMiddleware<{
  Bindings: Bindings;
  Variables: Variables;
}>(async (c, next) => {
  const runtime = ManagedRuntime.make(makeAppLayer(c.env));
  c.set("runtime", runtime);
  // oxlint-disable-next-line node/callback-return -- Hono middleware, not Express: cleanup must run after next()
  await next();
  await runtime.dispose();
});

app.use("*", withRuntime);

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const runtime = c.get("runtime");
  return runtime.runPromise(
    Effect.gen(function* handle() {
      const auth = yield* Auth;
      return yield* Effect.promise(() => auth.instance.handler(c.req.raw));
    })
  );
});

app.get("/api/tasks", async (c) => {
  const runtime = c.get("runtime");
  const tasks = await runtime.runPromise(
    Effect.gen(function* list() {
      const repo = yield* Task;
      return yield* repo.list();
    })
  );
  return c.json(tasks);
});

app.post("/api/tasks", async (c) => {
  const body = await c.req.json<{ title?: string }>();
  if (!body.title) {
    return c.json({ error: "title is required" }, 400);
  }

  const { title } = body;
  const runtime = c.get("runtime");
  const created = await runtime.runPromise(
    Effect.gen(function* create() {
      const repo = yield* Task;
      return yield* repo.create(title);
    })
  );
  return c.json(created, 201);
});

export default app;
