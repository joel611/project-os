import { envNumber } from "@project-os/config";
import { LocalLive } from "@project-os/infra-local";
import { ManagedRuntime } from "effect";
import { createApp } from "./app.ts";

// Local target: Bun + infra-local. The setInterval sweep lands in #15.
const port = envNumber("PORT", 8080);
const runtime = ManagedRuntime.make(
  LocalLive({ dbPath: process.env.DB_PATH ?? "project-os.sqlite", adapterUrls: {} }),
);
createApp({}, { mcp: runtime }).listen(port);
console.log(`coordinator listening on :${port} (MCP at /mcp)`);
