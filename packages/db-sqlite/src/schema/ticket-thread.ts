import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tickets } from "./ticket.ts";

/** The channel thread a ticket's conversation lives in: one per ticket, one ticket per thread. */
export const ticketThreads = sqliteTable(
  "ticket_threads",
  {
    ticketId: text("ticket_id")
      .primaryKey()
      .references(() => tickets.id),
    channelType: text("channel_type", { enum: ["discord", "email", "chat"] }).notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("ticket_threads_thread_uq").on(t.channelType, t.threadId)],
);
