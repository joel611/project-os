import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tickets } from "./ticket.ts";

/**
 * One row per agent session on a Ticket. The transcript is kept in file storage, in chunks at
 * `runs/<ticketId>/<id>/<seq>.jsonl`; this row is the index and the summary, and outlives the
 * transcript (`expired`).
 */
export const ticketRuns = sqliteTable(
  "ticket_runs",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id),
    workerId: text("worker_id").notNull(),
    agent: text("agent").notNull(),
    model: text("model"),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
    exitCode: integer("exit_code"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    eventCount: integer("event_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
    nextSeq: integer("next_seq").notNull().default(0),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    expired: integer("expired", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("ticket_runs_ticket_idx").on(t.ticketId, t.startedAt),
    index("ticket_runs_started_idx").on(t.startedAt),
  ],
);
