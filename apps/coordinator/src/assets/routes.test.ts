import { AssetStore, AssetStoreFailed, ChannelGateway, TicketRepository } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { McpServices } from "../mcp/tools.ts";
import { type AssetDeps, assetRoutes } from "./routes.ts";

const body = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const appWith = (store: Partial<typeof AssetStore.Service>) =>
  assetRoutes({
    run: <A>(effect: Effect.Effect<A, never, McpServices>) =>
      Effect.runPromise(
        (effect as Effect.Effect<A, never, AssetStore>).pipe(
          Effect.provideService(AssetStore, {
            ingest: () => Effect.void,
            get: () => Effect.undefined,
            link: () => Effect.undefined,
            verify: () => Effect.succeed(true),
            uploadLink: () => Effect.undefined,
            verifyUpload: () => Effect.succeed(true),
            put: () => Effect.void,
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

describe("asset upload route", () => {
  const put = (
    app: ReturnType<typeof appWith>,
    over: { length?: string | null; body?: string | null } = {},
  ) => {
    const headers = new Headers();
    const length = over.length === undefined ? "3" : over.length;
    if (length !== null) headers.set("content-length", length);
    return app.handle(
      new Request("http://localhost/assets/t1/a1/r.txt?exp=9999999999&sig=s", {
        method: "PUT",
        headers,
        ...(over.body !== null && { body: over.body ?? "abc" }),
      }),
    );
  };

  it("answers 411 without a content-length, 413 over the limit", async () => {
    expect((await put(appWith({}), { length: null })).status).toBe(411);
    expect((await put(appWith({}), { length: "0" })).status).toBe(411);
    expect((await put(appWith({}), { length: String(101 * 1024 * 1024) })).status).toBe(413);
  });

  it("answers 403 for a bad upload signature", async () => {
    const app = appWith({ verifyUpload: () => Effect.succeed(false) });
    expect((await put(app)).status).toBe(403);
  });

  it("answers 403 when the link carries no signature", async () => {
    const res = await appWith({ verifyUpload: () => Effect.succeed(false) }).handle(
      new Request("http://localhost/assets/t1/a1/r.txt?exp=9999999999", {
        method: "PUT",
        headers: { "content-length": "3" },
        body: "abc",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("answers 411 when there is no body to store", async () => {
    expect((await put(appWith({}), { body: null })).status).toBe(411);
  });

  it("answers 502 when the store refuses the bytes", async () => {
    const app = assetRoutes({
      run: <A>(effect: Effect.Effect<A, never, McpServices>) =>
        Effect.runPromise(
          (effect as Effect.Effect<A>).pipe(
            Effect.provideService(AssetStore, {
              verifyUpload: () => Effect.succeed(true),
              put: () => Effect.fail(new AssetStoreFailed({ message: "r2 down" })),
            } as unknown as typeof AssetStore.Service),
            Effect.provideService(ChannelGateway, {} as typeof ChannelGateway.Service),
            Effect.provideService(TicketRepository, {
              get: () => Effect.succeed({}),
            } as unknown as typeof TicketRepository.Service),
          ),
        ),
    });
    const res = await put(app as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The file could not be stored." });
  });

  it("answers 502 when the file can't be stored and 200 when it is", async () => {
    const answering = (outcome: string) =>
      assetRoutes({ run: (async () => outcome) as unknown as AssetDeps["run"] });
    expect((await put(answering("failed") as never)).status).toBe(502);
    expect((await put(answering("stored") as never)).status).toBe(200);
  });
});
