import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The real R2 backend and AssetStore in workerd (Miniflare, with an R2 bucket): a file from a
// fake CDN is streamed into R2 through a FixedLengthStream and read back, a wrong reported size
// is refused, and links verify. Every other outbound request is refused.

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

let mf: Miniflare;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./r2/worker.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["workerd", "worker", "import"],
    format: "esm",
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "r2-worker.js", contents: await built.outputs[0]!.text() }],
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["ASSETS"],
    outboundService: (request: Request) =>
      new URL(request.url).hostname === "cdn.test"
        ? new Response(BYTES, { headers: { "content-type": "application/octet-stream" } })
        : new Response("blocked", { status: 502 }),
  });
}, 60_000);

afterAll(() => mf.dispose());

const call = (path: string, params: Record<string, string>) =>
  mf.dispatchFetch(`http://worker.test${path}?${new URLSearchParams(params)}`);

describe("R2 asset storage in workerd", () => {
  it("streams a download into R2 and reads it back with its type and size", async () => {
    const ingested = await call("/ingest", {
      key: "t1/a1/hero.png",
      size: String(BYTES.byteLength),
      type: "image/png",
    });
    expect(await ingested.json()).toEqual({ ok: true });

    const read = await call("/get", { key: "t1/a1/hero.png" });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("x-size")).toBe(String(BYTES.byteLength));
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(BYTES);
  });

  it("reads a key nobody stored as missing", async () => {
    expect((await call("/get", { key: "t1/a1/none.png" })).status).toBe(404);
  });

  it.each([
    ["bigger than reported", BYTES.byteLength - 4],
    ["smaller than reported", BYTES.byteLength + 4],
  ])("refuses a file %s and stores nothing", async (_name, size) => {
    const key = `t2/a${size}/bad.png`;
    const result = (await (await call("/ingest", { key, size: String(size) })).json()) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect((await call("/get", { key })).status).toBe(404);
  });

  it("cuts a download off at the byte limit", async () => {
    const key = "t3/a1/big.png";
    const result = (await (
      await call("/ingest", { key, size: String(BYTES.byteLength), max: "4" })
    ).json()) as { ok: boolean; message?: string };
    expect(result).toMatchObject({ ok: false, message: "file is bigger than 4 bytes" });
    expect((await call("/get", { key })).status).toBe(404);
  });

  it("mints a link that verifies", async () => {
    const res = (await (await call("/link", { key: "t1/a1/hero.png" })).json()) as {
      link: string;
      valid: boolean;
    };
    expect(res.valid).toBe(true);
    expect(res.link).toMatch(
      /^https:\/\/coordinator\.test\/assets\/t1\/a1\/hero\.png\?exp=\d+&sig=/,
    );
  });
});
