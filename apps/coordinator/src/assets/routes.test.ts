import { AssetStore, AssetStoreFailed } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { assetRoutes } from "./routes.ts";

const body = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const appWith = (store: Partial<typeof AssetStore.Service>) =>
  assetRoutes({
    run: (effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(AssetStore, {
            ingest: () => Effect.void,
            get: () => Effect.succeed(undefined),
            link: () => Effect.succeed(undefined),
            verify: () => Effect.succeed(true),
            ...store,
          }),
        ),
      ),
  });

const get = (app: ReturnType<typeof appWith>, query = "?exp=9999999999&sig=s") =>
  app.handle(new Request(`http://localhost/assets/t1/a1/hero.png${query}`));

describe("asset routes", () => {
  it("streams a stored file as a download", async () => {
    const res = await get(
      appWith({
        get: (key) => {
          expect(key).toBe("t1/a1/hero.png");
          return Effect.succeed({ body: body("png"), contentType: "image/png", size: 3 });
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png");
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''hero.png");
  });

  it.each(["image/svg+xml", "text/html", "application/pdf", "video/mp4", "image/png2"])(
    "saves %s instead of showing it in place",
    async (contentType) => {
      const res = await get(
        appWith({
          get: () => Effect.succeed({ body: body("x"), contentType, size: 1 }),
        }),
      );
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    },
  );

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"])(
    "shows %s in place, for the dashboard's image tag",
    async (contentType) => {
      const res = await get(
        appWith({
          get: () => Effect.succeed({ body: body("x"), contentType, size: 1 }),
        }),
      );
      expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    },
  );

  it("answers 403 for a bad signature, without reading the store", async () => {
    const app = appWith({
      verify: () => Effect.succeed(false),
      get: () => Effect.die("must not read"),
    });
    expect((await get(app)).status).toBe(403);
    expect((await get(app, "?sig=s")).status).toBe(403);
    expect((await get(app, "?exp=9999999999")).status).toBe(403);
  });

  it("answers 404 when nothing is stored under a valid link", async () => {
    expect((await get(appWith({}))).status).toBe(404);
  });

  it("answers 502 when the store cannot read the file", async () => {
    const app = appWith({ get: () => Effect.fail(new AssetStoreFailed({ message: "r2 down" })) });
    const res = await get(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The file could not be read." });
  });
});
