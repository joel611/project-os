import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp } from "./app.ts";

// Cloudflare target: Workers + infra-cloudflare (out of POC scope).
// Elysia needs the adapter and .compile() on Workers.
export default createApp({ adapter: CloudflareAdapter }).compile();
