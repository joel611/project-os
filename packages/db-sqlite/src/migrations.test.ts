import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { describe, expect, it } from "vite-plus/test";

const folder = new URL("../migrations", import.meta.url).pathname;
const T = "2026-11-04T00:00:00.000Z";

const ticketRow = (id: string, status: string, workerId: string | null) =>
  `INSERT INTO tickets (id, project_id, status, title, input_summary, worker_id, created_at, last_activity_at, updated_at)
   VALUES ('${id}', 'p1', '${status}', 't', 't', ${workerId === null ? "NULL" : `'${workerId}'`}, '${T}', '${T}', '${T}')`;

const createdEvent = (ticketId: string, payload: unknown) =>
  `INSERT INTO ticket_events (id, ticket_id, type, actor, body, payload, created_at)
   VALUES ('e-${ticketId}', '${ticketId}', 'created', 'coordinator', '', '${JSON.stringify(payload)}', '${T}')`;

describe("add_ticket_requester migration", () => {
  it("adds the column to a fresh database", () => {
    const sqlite = new Database(":memory:");
    migrate(drizzle({ client: sqlite }), { migrationsFolder: folder });
    const columns = sqlite.query("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("requester");
  });

  it("backfills Queued tickets from their created event, and only those", () => {
    // The database as it was before this migration: every migration older than it.
    const before = mkdtempSync(join(tmpdir(), "migrations-before-"));
    const all = readdirSync(folder).sort();
    const index = all.findIndex((name) => name.endsWith("_add_ticket_requester"));
    for (const name of all.slice(0, index))
      cpSync(join(folder, name), join(before, name), { recursive: true });

    const sqlite = new Database(":memory:");
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: before });
    sqlite.run("INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'Org', '" + T + "')");
    sqlite.run(
      "INSERT INTO projects (id, org_id, name, custom_instructions, status, created_at, updated_at) VALUES ('p1', 'o1', 'P', '', 'active', '" +
        T +
        "', '" +
        T +
        "')",
    );
    const sender = { id: "u1", name: "Ada" };
    sqlite.run(ticketRow("queued", "open", null));
    sqlite.run(createdEvent("queued", { channelType: "discord", sender, attachments: [] }));
    sqlite.run(ticketRow("assigned", "assigned", "w1"));
    sqlite.run(createdEvent("assigned", { channelType: "discord", sender }));
    sqlite.run(ticketRow("no-sender", "open", null));
    sqlite.run(createdEvent("no-sender", { note: "no sender" }));
    sqlite.run(ticketRow("no-event", "open", null));

    migrate(db, { migrationsFolder: folder });

    const requesters = Object.fromEntries(
      (
        sqlite.query("SELECT id, requester FROM tickets").all() as Array<{
          id: string;
          requester: string | null;
        }>
      ).map((row) => [row.id, row.requester === null ? null : JSON.parse(row.requester)]),
    );
    expect(requesters).toEqual({
      queued: { channelType: "discord", id: "u1" },
      assigned: null,
      "no-sender": null,
      "no-event": null,
    });
  });
});
