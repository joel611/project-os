import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./project.ts";

export const memoryEntries = sqliteTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    ticketId: text("ticket_id"),
    type: text("type", {
      enum: ["email_summary", "manual", "status_update", "worker_result", "worker_note", "note"],
    }).notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceMetadata: text("source_metadata", { mode: "json" }),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("memory_entries_project_created_idx").on(t.projectId, t.createdAt)],
);
