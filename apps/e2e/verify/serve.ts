// Verification scaffold: boots the real Coordinator (HTTP + MCP + SQLite) with the two AI ports
// faked (classifier always `new_request`, agent runtime echo) and a recording Discord reply
// endpoint, all on fixed localhost ports. Mirrors apps/e2e/src/stack.ts, but long-running.
// Usage: DATA_DIR=<dir> bun serve.ts   (env: COORD_PORT=18080, ADAPTER_PORT=18081)
// Registers a shared worker "verify-box" (as an admin's `/register-worker shared:True` would) and
// saves its credentials to $DATA_DIR/worker.json for drive.ts. Signs the operator in and saves
// the session token to $DATA_DIR/operator.token (send it as `Authorization: Bearer` to read the
// API) and the service token to $DATA_DIR/service.token. Prints "READY ..." once a project +
// default Discord channel `verify-chan` exist.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAuth } from "@project-os/auth";
import { issueWorkerRegistration, redeemWorkerRegistration } from "@project-os/core";
import { ensureOrg, LocalLive, openLocalDb } from "@project-os/infra-local";
import { AgentRuntimeEcho, classifierReturning, makeSidekickRecording } from "@project-os/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createReplyApp } from "../../../packages/channel-discord/src/reply.ts";
import { makeAccess } from "../../coordinator/src/access.ts";
import { createApp } from "../../coordinator/src/app.ts";

/** Dashboard sign-in for the verify stack (the dashboard's /login page takes these). */
const OPERATOR = { email: "verify@project-os.test", password: "verify-password" };
const SERVICE_TOKEN = "verify-service-token";

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("DATA_DIR is required");
mkdirSync(dataDir, { recursive: true });
const coordPort = Number(process.env.COORD_PORT ?? 18080);
const adapterPort = Number(process.env.ADAPTER_PORT ?? 18081);
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
    makeSidekickRecording().layer,
  ) as Layer.Layer<any, never>,
);

const url = `http://localhost:${coordPort}`;
const auth = makeAuth({
  db: openLocalDb(dbPath).db,
  baseURL: url,
  secret: "verify-secret-verify-secret-verify",
  admin: OPERATOR,
});
await auth.ready();

createApp(
  {},
  {
    access: makeAccess({ serviceToken: SERVICE_TOKEN, auth }),
    auth,
    http: { run: (e) => runtime.runPromise(e as any), inbound: {} },
    mcp: runtime as any,
  },
).listen(coordPort);

const signIn = await fetch(`${url}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(OPERATOR),
});
const operatorToken = signIn.headers.get("set-auth-token");
if (!operatorToken) throw new Error(`operator sign-in failed: ${signIn.status}`);
writeFileSync(join(dataDir, "operator.token"), operatorToken);
writeFileSync(join(dataDir, "service.token"), SERVICE_TOKEN);

const post = (path: string, body: unknown) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);

const project = await post("/projects", { orgId, name: "Verify Project" });
await post(`/projects/${project.id}/sources`, {
  type: "discord_channel",
  externalId: "verify-chan",
  name: "#verify-chan",
  alias: "verify",
  isDefaultResponse: true,
});
const register = (shared: boolean, userId: string, name: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { token } = yield* issueWorkerRegistration(
        { channelType: "discord", id: userId },
        { shared },
      );
      return yield* Effect.orDie(redeemWorkerRegistration({ token, name }));
    }) as Effect.Effect<{ readonly worker: { readonly id: string }; readonly secret: string }>,
  );
const shared = await register(true, "verify-admin", "verify-box");
writeFileSync(
  join(dataDir, "worker.json"),
  JSON.stringify({ workerId: shared.worker.id, secret: shared.secret }),
);
// A personal device for someone else, never online: shows up in the dashboard, takes nothing.
await register(false, "u9", "bob-laptop");
console.log(
  `READY coordinator=${url} adapter=http://localhost:${adapterPort} project=${project.id} worker=${shared.worker.id} login=${OPERATOR.email}/${OPERATOR.password}`,
);
