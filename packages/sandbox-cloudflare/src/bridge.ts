import type { SessionStatus, StartSession } from "./protocol.ts";

/** The slice of a `@cloudflare/sandbox` Sandbox stub the bridge uses, so tests can fake it. */
export interface SandboxStubLike {
  readonly startProcess: (
    command: string,
    options: { readonly processId: string; readonly env: Record<string, string> },
  ) => Promise<unknown>;
  readonly getProcess: (id: string) => Promise<{
    readonly status: string;
    readonly exitCode?: number;
  } | null>;
  readonly getProcessLogs: (
    id: string,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly destroy: () => Promise<void>;
}

export interface BridgeDeps {
  /** Expected bearer token. Requests without it get 401. */
  readonly token: string;
  /** The sandbox for a session id: `getSandbox(env.Sandbox, id)` in the Worker. */
  readonly sandbox: (id: string) => SandboxStubLike;
  readonly newId: () => string;
}

/** One sandbox per session, one process per sandbox. */
const PROCESS_ID = "worker";
const OUTPUT_TAIL = 4_000;
const DONE = new Set(["completed", "failed", "killed", "error"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sameSecret = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** The bridge Worker's `fetch`: see protocol.ts for the routes. */
export const handleBridge = async (request: Request, deps: BridgeDeps): Promise<Response> => {
  if (deps.token === "") return json({ error: "BRIDGE_TOKEN is not set" }, 500);
  const auth = request.headers.get("authorization") ?? "";
  if (!sameSecret(auth, `Bearer ${deps.token}`)) return json({ error: "unauthorized" }, 401);

  const { pathname } = new URL(request.url);
  if (pathname === "/sessions" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as StartSession | null;
    if (
      !body ||
      typeof body.command !== "string" ||
      typeof body.env !== "object" ||
      body.env === null
    ) {
      return json({ error: "expected { command, env }" }, 400);
    }
    const id = deps.newId();
    await deps
      .sandbox(id)
      .startProcess(body.command, { processId: PROCESS_ID, env: { ...body.env } });
    return json({ id }, 201);
  }

  const match = /^\/sessions\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match) return json({ error: "not found" }, 404);
  const sandbox = deps.sandbox(match[1]!);
  if (request.method === "GET") {
    const proc = await sandbox.getProcess(PROCESS_ID);
    if (proc === null) return json({ error: "no such session" }, 404);
    if (!DONE.has(proc.status)) return json({ state: "running" } satisfies SessionStatus);
    const logs = await sandbox.getProcessLogs(PROCESS_ID);
    const output = `${logs.stdout}${logs.stderr}`.slice(-OUTPUT_TAIL);
    return json({
      state: "exited",
      exitCode: proc.exitCode ?? (proc.status === "completed" ? 0 : 1),
      output,
    } satisfies SessionStatus);
  }
  if (request.method === "DELETE") {
    await sandbox.destroy();
    return new Response(null, { status: 204 });
  }
  return json({ error: "method not allowed" }, 405);
};
