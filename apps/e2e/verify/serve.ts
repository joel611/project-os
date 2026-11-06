// Verification scaffold: boots the real Coordinator (HTTP + MCP + SQLite) with the two AI ports
// faked (classifier always `new_request`, agent runtime echo) and a recording Discord reply
// endpoint, all on fixed localhost ports. Mirrors apps/e2e/src/stack.ts, but long-running.
// Usage: DATA_DIR=<dir> bun serve.ts   (env: COORD_PORT=18080, ADAPTER_PORT=18081, WORKER_ID=verify-worker)
// Prints "READY ..." once a project + default Discord channel `verify-chan` exist.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureOrg, LocalLive } from "@project-os/infra-local";
import { AgentRuntimeEcho, classifierReturning } from "@project-os/testing";
import { Layer, ManagedRuntime } from "effect";
import { createReplyApp } from "../../../packages/channel-discord/src/reply.ts";
import { createApp } from "../../coordinator/src/app.ts";

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("DATA_DIR is required");
mkdirSync(dataDir, { recursive: true });
const coordPort = Number(process.env.COORD_PORT ?? 18080);
const adapterPort = Number(process.env.ADAPTER_PORT ?? 18081);
const workerId = process.env.WORKER_ID ?? "verify-worker";
const dbPath = join(dataDir, "project-os.sqlite");
const postedLog = join(dataDir, "posted.jsonl");

const orgId = ensureOrg(dbPath, { id: "verify-org", name: "Verify Org" });

createReplyApp(async (target, content) =>
  appendFileSync(postedLog, JSON.stringify({ target, content }) + "\n"),
).listen(adapterPort);

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LocalLive({ dbPath, adapterUrls: { discord: `http://localhost:${adapterPort}` } }),
    classifierReturning("new_request"),
    AgentRuntimeEcho,
  ) as Layer.Layer<any, never>,
);

createApp(
  {},
  {
    http: { run: (e) => runtime.runPromise(e as any), inbound: { workerId } },
    mcp: runtime as any,
  },
).listen(coordPort);

const url = `http://localhost:${coordPort}`;
const post = (path: string, body: unknown) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);

const project = await post("/projects", { orgId, name: "Verify Project" });
await post(`/projects/${project.id}/sources`, {
  type: "discord_channel",
  externalId: "verify-chan",
  name: "#verify-chan",
  isDefaultResponse: true,
});
console.log(
  `READY coordinator=${url} adapter=http://localhost:${adapterPort} project=${project.id} worker=${workerId}`,
);
