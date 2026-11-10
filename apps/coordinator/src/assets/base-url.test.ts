import { describe, expect, it } from "vite-plus/test";
import { assetBaseUrl } from "./base-url.ts";

describe("assetBaseUrl", () => {
  const publicUrl = "http://localhost:8080";

  it("uses PUBLIC_URL when no sandbox pool is configured", () => {
    expect(assetBaseUrl({}, publicUrl)).toBe(publicUrl);
  });

  it("uses the origin of the sandbox-reachable URL, which a cloud sandbox can reach", () => {
    expect(assetBaseUrl({ SANDBOX_MCP_URL: "https://tunnel.example.com/mcp" }, publicUrl)).toBe(
      "https://tunnel.example.com",
    );
  });

  it("honours the older DAYTONA_MCP_URL name, and ignores an empty value", () => {
    expect(assetBaseUrl({ DAYTONA_MCP_URL: "https://old.example.com/mcp" }, publicUrl)).toBe(
      "https://old.example.com",
    );
    expect(assetBaseUrl({ SANDBOX_MCP_URL: "" }, publicUrl)).toBe(publicUrl);
  });
});
