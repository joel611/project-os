import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { migrationsFolder } from "./index.ts";

const sql = (migration: string) =>
  readFileSync(`${migrationsFolder}/${migration}/migration.sql`, "utf8").split(
    "--> statement-breakpoint",
  );

describe("20261108040050_local_worker_type", () => {
  it("folds local_claude and local_pi into local, in workers, tickets and event payloads", () => {
    const db = new Database(":memory:");
    for (const statement of sql("20261107121658_init")) db.run(statement);

    db.run("INSERT INTO workers (id, worker_type, last_seen_at, created_at) VALUES (?, ?, ?, ?)", [
      "w1",
      "local_claude",
      "t",
      "t",
    ]);
    db.run("INSERT INTO workers (id, worker_type, last_seen_at, created_at) VALUES (?, ?, ?, ?)", [
      "w2",
      "daytona_pi",
      "t",
      "t",
    ]);
    db.run("PRAGMA foreign_keys = OFF");
    for (const [id, type] of [
      ["t1", "local_pi"],
      ["t2", "sidekick"],
    ] as const) {
      db.run(
        "INSERT INTO tickets (id, project_id, status, title, input_summary, worker_type, created_at, last_activity_at, updated_at) VALUES (?, 'p', 'open', 't', 's', ?, 't', 't', 't')",
        [id, type],
      );
    }
    db.run(
      "INSERT INTO ticket_events (id, ticket_id, type, actor, body, payload, created_at) VALUES ('e1', 't1', 'assigned', 'coordinator', 'b', ?, 't')",
      ['{"workerType":"local_claude","workerId":"w1"}'],
    );
    db.run(
      "INSERT INTO ticket_events (id, ticket_id, type, actor, body, payload, created_at) VALUES ('e2', 't1', 'comment', 'worker', 'b', ?, 't')",
      ['{"note":"local_claude is fine here"}'],
    );
    db.run(
      "INSERT INTO ticket_events (id, ticket_id, type, actor, body, payload, created_at) VALUES ('e3', 't1', 'comment', 'worker', 'b', NULL, 't')",
    );

    for (const statement of sql("20261108040050_local_worker_type")) db.run(statement);

    const types = (table: string) =>
      db
        .query(`SELECT worker_type AS t FROM ${table} ORDER BY id`)
        .all()
        .map((r) => (r as { t: string }).t);
    expect(types("workers")).toEqual(["local", "daytona_pi"]);
    expect(types("tickets")).toEqual(["local", "sidekick"]);
    const payloads = db
      .query("SELECT payload AS p FROM ticket_events ORDER BY id")
      .all()
      .map((r) => (r as { p: string | null }).p);
    expect(payloads).toEqual([
      '{"workerType":"local","workerId":"w1"}',
      '{"note":"local_claude is fine here"}',
      null,
    ]);
  });
});
