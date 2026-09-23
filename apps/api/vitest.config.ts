import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "src/__tests__/cloudflare-workers-shim.ts",
        import.meta.url
      ).pathname,
    },
  },
});
