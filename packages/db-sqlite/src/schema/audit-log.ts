import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./project.ts";

/**
 * Append-only audit log: inbound messages, Channel Digest runs, Worker and Ticket changes.
 * `project_id` is null for rows that belong to no project; they show only org-wide.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: text("at").notNull(),
    kind: text("kind", {
      enum: ["inbound_event", "digest_event", "worker", "ticket", "connection", "runtime_error"],
    }).notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type", { enum: ["person", "worker", "coordinator"] }).notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    ticketId: text("ticket_id"),
    workerId: text("worker_id"),
    summary: text("summary").notNull(),
    payload: text("payload", { mode: "json" }),
    /** Set for entries logged at most once (an inbound message, a Worker outage). */
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    uniqueIndex("audit_log_dedupe_uq").on(t.dedupeKey),
    index("audit_log_at_idx").on(t.at),
    // Reads go newest-logged first (rowid), which SQLite keeps at the end of every index.
    index("audit_log_project_idx").on(t.projectId),
    index("audit_log_worker_idx").on(t.workerId),
    index("audit_log_kind_idx").on(t.kind),
  ],
);
