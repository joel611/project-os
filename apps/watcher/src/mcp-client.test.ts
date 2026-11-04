import { describe, expect, it } from "vite-plus/test";
import { httpMcpClient } from "./mcp-client.ts";

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const text = (t: string, isError = false) => ({
  result: { content: [{ type: "text", text: t }], isError },
});

describe("httpMcpClient", () => {
  it("posts a JSON-RPC tools/call and parses the text content", async () => {
    let req: { body: any; headers: Headers } | undefined;
    const fetcher = (async (_url: string, init: RequestInit) => {
      req = { body: JSON.parse(init.body as string), headers: new Headers(init.headers) };
      return new Response(JSON.stringify(text('{"a":1}')));
    }) as unknown as typeof fetch;
    const client = httpMcpClient("http://c/mcp", fetcher);
    expect(await client.callTool("t", { x: 1 })).toEqual({ a: 1 });
    expect(req?.body).toMatchObject({
      method: "tools/call",
      id: 1,
      params: { name: "t", arguments: { x: 1 } },
    });
    await client.callTool("t", {});
    expect(req?.body.id).toBe(2);
  });

  it("throws on HTTP errors", async () => {
    await expect(httpMcpClient("u", json({}, 500)).callTool("t", {})).rejects.toThrow(/HTTP 500/);
  });

  it("throws on JSON-RPC errors", async () => {
    const c = httpMcpClient("u", json({ error: { message: "bad" } }));
    await expect(c.callTool("t", {})).rejects.toThrow(/bad/);
  });

  it("throws when the tool reports isError", async () => {
    const c = httpMcpClient("u", json(text("nope", true)));
    await expect(c.callTool("t", {})).rejects.toThrow(/nope/);
  });

  it("returns null when there is no text content", async () => {
    expect(await httpMcpClient("u", json({ result: {} })).callTool("t", {})).toBeNull();
    expect(await httpMcpClient("u", json({})).callTool("t", {})).toBeNull();
  });
});
