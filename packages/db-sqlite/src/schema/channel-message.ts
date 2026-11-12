import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./project.ts";

/** Project channel messages waiting for the Channel Digest; rows are deleted once digested. */
export const channelMessages = sqliteTable(
  "channel_messages",
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
    sentAt: text("sent_at").notNull(),
  },
  (t) => [
    uniqueIndex("channel_messages_external_uq").on(t.channelType, t.externalId),
    index("channel_messages_project_sent_idx").on(t.projectId, t.sentAt),
  ],
);
