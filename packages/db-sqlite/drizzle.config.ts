import { defineConfig } from "drizzle-kit";

// One SQLite schema shared by D1 (Cloudflare) and bun:sqlite (local).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
