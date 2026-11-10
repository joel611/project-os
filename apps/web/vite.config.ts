import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const coordinator = process.env.COORDINATOR_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [
    // SPA export: one static index.html shell serves every path.
    tanstackStart({ spa: { enabled: true, prerender: { outputPath: "/index.html" } } }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // The dashboard calls `/api/*`; the Coordinator serves the same paths at its root, except
  // Better Auth, which it serves at `/api/auth/*` itself. First match wins, so that comes first.
  server: {
    port: 5173,
    proxy: {
      // Through the proxy the dashboard is same-origin with the Coordinator, so sign-in
      // carries the Coordinator's origin and passes Better Auth's origin check.
      "/api/auth": { target: coordinator, headers: { origin: new URL(coordinator).origin } },
      "/api": { target: coordinator, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
