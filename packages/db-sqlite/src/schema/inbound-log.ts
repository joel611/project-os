import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./project.ts";

/** Every message received in a project's channels, kept for the dashboard's Channel tab. */
export const inboundLog = sqliteTable(
  "inbound_log",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    channelType: text("channel_type", { enum: ["discord", "email", "chat"] }).notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    externalId: text("external_id").notNull(),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name"),
    content: text("content").notNull(),
    mentionsBot: integer("mentions_bot", { mode: "boolean" }).notNull(),
    attachmentCount: integer("attachment_count").notNull(),
    url: text("url"),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [
    uniqueIndex("inbound_log_external_uq").on(t.channelType, t.externalId),
    index("inbound_log_project_received_idx").on(t.projectId, t.receivedAt),
  ],
);
