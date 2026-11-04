import { describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";

describe("coordinator app", () => {
  it("serves GET /health", async () => {
    const res = await createApp().handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "coordinator" });
  });
});
