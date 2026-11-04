import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  workerType: text("worker_type", { enum: ["daytona_pi", "local_claude", "local_pi"] }).notNull(),
  currentTicketId: text("current_ticket_id"),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at").notNull(),
});
