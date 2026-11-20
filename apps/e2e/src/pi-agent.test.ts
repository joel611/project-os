import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

// The real PiAgent Durable Object in workerd (Miniflare), behind a Worker that reaches it
// through durableAgentRuntime. Faked: the chat model (pi-ai's faux provider, swapped in by a
// PiAgent subclass); every outbound fetch is refused. Real: workerd, DO SQLite storage, D1.

// Every migration, oldest first.
const migrations = new URL("../../../packages/db-sqlite/migrations/", import.meta.url);
const migration = readdirSync(migrations)
  .sort()
  .map((name) => readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"))
  .join("\n--> statement-breakpoint\n")
  .replace(/CREATE (UNIQUE )?(TABLE|INDEX)/g, "CREATE $1$2 IF NOT EXISTS");

let dir: string;
let script: string;
const instances: Miniflare[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-agent-e2e-"));
  const built = await Bun.build({
    entrypoints: [new URL("./pi-agent/worker.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["workerd", "worker", "import"],
    format: "esm",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  script = await built.outputs[0]!.text();
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(instances.splice(0).map((mf) => mf.dispose().catch(() => undefined)));
});

/** One workerd with state kept under `dir`, so a second one is the same Worker after a restart. */
const boot = async (root = mkdtempSync(join(dir, "state-"))) => {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { DISCORD_PROJECT_CHANNEL_AUTO_CREATE: "false" },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    durableObjects: { PI_AGENT: { className: "TestAgent", useSQLite: true } },
    defaultPersistRoot: root,
    outboundService: () =>
      new Response("blocked: the test makes no outbound requests", { status: 502 }),
  });
  instances.push(mf);
  const db = await mf.getD1Database("DB");
  // A restart reuses the persisted database: renames and ADDs only run once.
  const migrated = await db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'orgs'").first();
  for (const statement of migrated ? [] : migration.split("--> statement-breakpoint")) {
    if (statement.trim() === "") continue;
    await db.prepare(statement).run();
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('default-org', 'Default', '2026-01-01')",
    )
    .run();
  const respond = async (input: { sessionId: string; prompt: string; requestId?: string }) =>
    (await (
      await mf.dispatchFetch("http://worker/", { method: "POST", body: JSON.stringify(input) })
    ).json()) as { ok: true; text: string } | { ok: false; message: string };
  return { mf, db, respond, root };
};

describe("PiAgent Durable Object", () => {
  it("answers through the Worker and keeps each session's history apart", async () => {
    const { respond } = await boot();

    const a1 = await respond({ sessionId: "project:a", prompt: "one" });
    const a2 = await respond({ sessionId: "project:a", prompt: "two" });
    const b1 = await respond({ sessionId: "project:b", prompt: "other" });

    // History counts the conversation's instructions as its first message.
    expect(a1).toEqual({ ok: true, text: expect.stringMatching(/^call 1, history 2/) });
    // The second turn of one session carries the first turn's messages.
    expect(a2).toEqual({ ok: true, text: expect.stringMatching(/history 4$/) });
    // Another session is another object: its own model, its own history.
    expect(b1).toEqual({ ok: true, text: expect.stringMatching(/^call 1, history 2/) });
  });

  it("does not answer a re-delivered request twice", async () => {
    const { respond } = await boot();

    const first = await respond({ sessionId: "project:a", prompt: "hi", requestId: "ext-1" });
    const again = await respond({ sessionId: "project:a", prompt: "hi", requestId: "ext-1" });

    expect(again).toEqual(first);
    const next = await respond({ sessionId: "project:a", prompt: "new", requestId: "ext-2" });
    expect(next).toEqual({ ok: true, text: expect.stringMatching(/^call 2,/) });
  });

  it("runs an admin tool against the Worker's D1", async () => {
    const { respond, db } = await boot();

    const reply = await respond({ sessionId: "admin:chan", prompt: "create project Acme" });

    expect(reply).toEqual({ ok: true, text: expect.stringMatching(/^tool said: .*Acme/) });
    const { results } = await db.prepare("SELECT name FROM projects").all();
    expect(results).toEqual([{ name: "Acme" }]);
  });

  it("resumes a session's conversation after the Worker restarts", async () => {
    const first = await boot();
    await first.respond({ sessionId: "project:a", prompt: "remember me" });
    await first.mf.dispose();

    const { respond } = await boot(first.root);
    const after = await respond({ sessionId: "project:a", prompt: "still there?" });

    // Two earlier messages came back from storage: history is 3 (user, assistant, user).
    expect(after).toEqual({ ok: true, text: expect.stringMatching(/history 4$/) });
  });
});
